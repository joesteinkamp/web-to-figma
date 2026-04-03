const FIGMA_CLIENT_ID = "sqdN9lM5st0HEGMIWZpIXe";
const FIGMA_CLIENT_SECRET = "aONX4unCfggS59OGJgakAUzy39l1VA";

const MCP_BASE = "https://mcp.figma.com";
const MCP_URL = `${MCP_BASE}/mcp`;

// ─── PKCE Helpers ───

function base64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64url(array);
}

async function generateCodeChallenge(verifier) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64url(hash);
}

// ─── OAuth ───

// Try MCP server's own OAuth, fall back to Figma standard
let authUrl = null;
let tokenUrl = null;

async function discoverOAuthEndpoints() {
  if (authUrl && tokenUrl) return;

  try {
    const resp = await fetch(`${MCP_BASE}/.well-known/oauth-authorization-server`);
    if (resp.ok) {
      const metadata = await resp.json();
      console.log("MCP OAuth metadata:", JSON.stringify(metadata));
      authUrl = metadata.authorization_endpoint;
      tokenUrl = metadata.token_endpoint;
      return;
    }
    console.log("MCP OAuth discovery failed:", resp.status);
  } catch (e) {
    console.log("MCP OAuth discovery error:", e.message);
  }

  // Fallback
  authUrl = "https://www.figma.com/oauth";
  tokenUrl = "https://api.figma.com/v1/oauth/token";
}

async function getAccessToken() {
  const stored = await chrome.storage.local.get([
    "figmaAccessToken",
    "figmaRefreshToken",
    "figmaTokenExpiry",
  ]);

  // Valid token
  if (stored.figmaAccessToken && stored.figmaTokenExpiry > Date.now() + 60000) {
    return stored.figmaAccessToken;
  }

  // Try refresh
  if (stored.figmaRefreshToken) {
    try {
      return await refreshToken(stored.figmaRefreshToken);
    } catch {}
  }

  // Full OAuth flow
  return await doOAuthFlow();
}

async function doOAuthFlow() {
  if (FIGMA_CLIENT_ID === "YOUR_FIGMA_CLIENT_ID") {
    throw new Error(
      "Figma OAuth not configured. Set FIGMA_CLIENT_ID in background.js"
    );
  }

  await discoverOAuthEndpoints();

  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const redirectUri = chrome.identity.getRedirectURL();

  const oauthUrl = new URL(authUrl);
  oauthUrl.searchParams.set("client_id", FIGMA_CLIENT_ID);
  oauthUrl.searchParams.set("redirect_uri", redirectUri);
  oauthUrl.searchParams.set("response_type", "code");
  oauthUrl.searchParams.set("code_challenge", challenge);
  oauthUrl.searchParams.set("code_challenge_method", "S256");
  oauthUrl.searchParams.set("scope", "file_content:read file_metadata:read file_versions:read");
  oauthUrl.searchParams.set("state", crypto.randomUUID());

  console.log("OAuth URL:", oauthUrl.toString());
  console.log("Redirect URI:", redirectUri);

  let resultUrl;
  try {
    resultUrl = await chrome.identity.launchWebAuthFlow({
      url: oauthUrl.toString(),
      interactive: true,
    });
    console.log("Auth result URL:", resultUrl);
  } catch (e) {
    console.error("launchWebAuthFlow failed:", e);
    throw e;
  }

  const params = new URL(resultUrl).searchParams;
  const code = params.get("code");
  console.log("Auth code received:", code ? "yes" : "no", "params:", resultUrl);
  if (!code) {
    throw new Error(
      "No authorization code from Figma: " + (params.get("error") || "unknown")
    );
  }

  // Exchange code for token (Figma requires HTTP Basic Auth)
  const basicAuth = btoa(`${FIGMA_CLIENT_ID}:${FIGMA_CLIENT_SECRET}`);
  const tokenBody = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  };
  console.log("Token exchange request to:", tokenUrl);

  const tokenResp = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${basicAuth}`,
    },
    body: new URLSearchParams(tokenBody),
  });

  const tokenText = await tokenResp.text();
  console.log("Token response:", tokenResp.status, tokenText);

  if (!tokenResp.ok) {
    throw new Error(`Token exchange failed (${tokenResp.status}): ${tokenText}`);
  }

  const tokens = JSON.parse(tokenText);
  await chrome.storage.local.set({
    figmaAccessToken: tokens.access_token,
    figmaRefreshToken: tokens.refresh_token || null,
    figmaTokenExpiry: Date.now() + (tokens.expires_in || 3600) * 1000,
  });

  return tokens.access_token;
}

async function refreshToken(refreshToken) {
  await discoverOAuthEndpoints();
  const basicAuth = btoa(`${FIGMA_CLIENT_ID}:${FIGMA_CLIENT_SECRET}`);
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!resp.ok) throw new Error("Token refresh failed");
  const tokens = await resp.json();

  await chrome.storage.local.set({
    figmaAccessToken: tokens.access_token,
    figmaRefreshToken: tokens.refresh_token || refreshToken,
    figmaTokenExpiry: Date.now() + (tokens.expires_in || 3600) * 1000,
  });

  return tokens.access_token;
}

// ─── MCP Streamable HTTP Client ───

let mcpSessionId = null;
let mcpInitialized = false;
let mcpNextId = 1;

async function mcpRequest(method, params, isNotification = false) {
  const token = await getAccessToken();
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    Accept: "application/json, text/event-stream",
  };
  if (mcpSessionId) {
    headers["Mcp-Session-Id"] = mcpSessionId;
  }

  const body = isNotification
    ? { jsonrpc: "2.0", method, params: params || {} }
    : { jsonrpc: "2.0", id: mcpNextId++, method, params: params || {} };

  const resp = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const sid = resp.headers.get("mcp-session-id");
  if (sid) mcpSessionId = sid;

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error(`MCP ${method} failed:`, resp.status, text);
    if (resp.status === 401) {
      await chrome.storage.local.remove(["figmaAccessToken"]);
      throw new Error("AUTH_EXPIRED");
    }
    throw new Error(`MCP error (${resp.status}): ${text}`);
  }
  console.log(`MCP ${method}: ${resp.status} OK`);

  if (isNotification || resp.status === 202) return null;

  const contentType = resp.headers.get("content-type") || "";

  if (contentType.includes("text/event-stream")) {
    const text = await resp.text();
    const lines = text.split("\n");
    let lastData = null;
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        lastData = line.slice(6);
      }
    }
    if (lastData) {
      const parsed = JSON.parse(lastData);
      if (parsed.error) throw new Error(parsed.error.message);
      return parsed.result;
    }
    return null;
  }

  const result = await resp.json();
  if (result.error) throw new Error(result.error.message);
  return result.result;
}

async function ensureMcpSession() {
  if (mcpInitialized) return;
  await mcpRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "web-to-figma", version: "3.0.0" },
  });
  await mcpRequest("notifications/initialized", {}, true);
  mcpInitialized = true;
}

function resetMcp() {
  mcpInitialized = false;
  mcpSessionId = null;
  mcpNextId = 1;
}

// ─── Capture ───

async function handleCapture(tab) {
  await ensureMcpSession();

  // 1. Generate capture session via Figma MCP
  const toolResult = await mcpRequest("tools/call", {
    name: "generate_figma_design",
    arguments: { title: tab.title || "Web Capture" },
  });

  // 2. Extract captureId + endpoint
  let captureId, endpoint;
  if (toolResult?.content) {
    for (const item of toolResult.content) {
      if (item.type === "text") {
        try {
          const parsed = JSON.parse(item.text);
          captureId = captureId || parsed.captureId;
          endpoint = endpoint || parsed.endpoint;
        } catch {
          const idMatch = item.text.match(
            /captureId["'\s:]+([a-zA-Z0-9_-]+)/
          );
          const epMatch = item.text.match(
            /endpoint["'\s:]+(https?:\/\/[^\s"']+)/
          );
          if (idMatch) captureId = captureId || idMatch[1];
          if (epMatch) endpoint = endpoint || epMatch[1];
        }
      }
    }
  }

  if (!captureId || !endpoint) {
    throw new Error(
      "Could not get capture config from Figma. " +
        JSON.stringify(toolResult).slice(0, 300)
    );
  }

  // 3. Fetch + inject capture script
  const scriptResp = await fetch(
    `${MCP_BASE}/mcp/html-to-design/capture.js`
  );
  if (!scriptResp.ok) throw new Error("Failed to fetch Figma capture script");
  const scriptText = await scriptResp.text();

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (code) => {
      const el = document.createElement("script");
      el.textContent = code;
      document.head.appendChild(el);
    },
    args: [scriptText],
    world: "MAIN",
  });

  await new Promise((r) => setTimeout(r, 1000));

  // 4. Trigger capture
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (cid, ep) => {
      if (!window.figma || !window.figma.captureForDesign) {
        throw new Error("Figma capture script did not initialize");
      }
      return window.figma.captureForDesign({
        captureId: cid,
        endpoint: ep,
        selector: "body",
      });
    },
    args: [captureId, endpoint],
    world: "MAIN",
  });

  return { success: true, result: results[0]?.result };
}

// ─── Message Handler ───

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "capture") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab) throw new Error("No active tab found");
        const result = await handleCapture(tab);
        sendResponse(result);
      } catch (err) {
        if (err.message === "AUTH_EXPIRED") {
          try {
            resetMcp();
            const [tab] = await chrome.tabs.query({
              active: true,
              currentWindow: true,
            });
            sendResponse(await handleCapture(tab));
            return;
          } catch (retryErr) {
            sendResponse({ success: false, error: retryErr.message });
            return;
          }
        }
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === "checkAuth") {
    chrome.storage.local.get(
      ["figmaAccessToken", "figmaTokenExpiry"],
      (data) => {
        sendResponse({
          authenticated: !!(
            data.figmaAccessToken && data.figmaTokenExpiry > Date.now()
          ),
        });
      }
    );
    return true;
  }

  if (message.action === "logout") {
    chrome.storage.local.remove(
      ["figmaAccessToken", "figmaRefreshToken", "figmaTokenExpiry"],
      () => {
        resetMcp();
        sendResponse({ success: true });
      }
    );
    return true;
  }
});
