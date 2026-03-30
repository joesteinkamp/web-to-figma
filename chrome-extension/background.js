// Figma remote MCP server
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

async function getOAuthMetadata() {
  const resp = await fetch(
    `${MCP_BASE}/.well-known/oauth-authorization-server`
  );
  if (!resp.ok)
    throw new Error(`Failed to fetch OAuth metadata: ${resp.status}`);
  return resp.json();
}

async function dynamicClientRegistration(metadata) {
  if (!metadata.registration_endpoint) {
    throw new Error(
      "Figma MCP server does not support dynamic client registration"
    );
  }
  const redirectUri = chrome.identity.getRedirectURL();
  const resp = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Web to Figma Chrome Extension",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Client registration failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

async function getAccessToken() {
  const stored = await chrome.storage.local.get([
    "figmaAccessToken",
    "figmaRefreshToken",
    "figmaTokenExpiry",
    "figmaClientId",
  ]);

  // Valid token exists
  if (stored.figmaAccessToken && stored.figmaTokenExpiry > Date.now() + 60000) {
    return stored.figmaAccessToken;
  }

  // Try refresh
  if (stored.figmaRefreshToken && stored.figmaClientId) {
    try {
      const metadata = await getOAuthMetadata();
      return await refreshAccessToken(metadata, stored);
    } catch {
      // Fall through to full auth
    }
  }

  // Full OAuth flow
  return await fullOAuthFlow();
}

async function fullOAuthFlow() {
  const metadata = await getOAuthMetadata();

  // Register client if needed
  let { figmaClientId } = await chrome.storage.local.get(["figmaClientId"]);
  if (!figmaClientId) {
    const reg = await dynamicClientRegistration(metadata);
    figmaClientId = reg.client_id;
    await chrome.storage.local.set({ figmaClientId });
  }

  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const redirectUri = chrome.identity.getRedirectURL();

  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set("client_id", figmaClientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  if (metadata.scopes_supported?.length) {
    authUrl.searchParams.set("scope", metadata.scopes_supported.join(" "));
  }

  const resultUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });

  const code = new URL(resultUrl).searchParams.get("code");
  if (!code) throw new Error("No authorization code received from Figma");

  // Exchange code for tokens
  const tokenResp = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: figmaClientId,
      code_verifier: verifier,
    }),
  });

  if (!tokenResp.ok) {
    const text = await tokenResp.text().catch(() => "");
    throw new Error(`Token exchange failed (${tokenResp.status}): ${text}`);
  }

  const tokens = await tokenResp.json();
  await chrome.storage.local.set({
    figmaAccessToken: tokens.access_token,
    figmaRefreshToken: tokens.refresh_token || null,
    figmaTokenExpiry: Date.now() + (tokens.expires_in || 3600) * 1000,
  });

  return tokens.access_token;
}

async function refreshAccessToken(metadata, stored) {
  const resp = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stored.figmaRefreshToken,
      client_id: stored.figmaClientId,
    }),
  });

  if (!resp.ok) throw new Error("Token refresh failed");
  const tokens = await resp.json();

  await chrome.storage.local.set({
    figmaAccessToken: tokens.access_token,
    figmaRefreshToken: tokens.refresh_token || stored.figmaRefreshToken,
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

  const newSessionId = resp.headers.get("mcp-session-id");
  if (newSessionId) mcpSessionId = newSessionId;

  if (resp.status === 401) {
    await chrome.storage.local.remove(["figmaAccessToken"]);
    throw new Error("AUTH_EXPIRED");
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`MCP error (${resp.status}): ${text}`);
  }

  // Notifications return 202 with no body
  if (isNotification || resp.status === 202) return null;

  const contentType = resp.headers.get("content-type") || "";

  if (contentType.includes("text/event-stream")) {
    // SSE response — extract the final JSON-RPC result
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
    clientInfo: { name: "web-to-figma-extension", version: "2.0.0" },
  });

  await mcpRequest("notifications/initialized", {}, true);
  mcpInitialized = true;
}

function resetMcpSession() {
  mcpInitialized = false;
  mcpSessionId = null;
}

// ─── One-Click Capture ───

async function handleCapture(tab) {
  await ensureMcpSession();

  // 1. Call generate_figma_design to get captureId + endpoint
  const toolResult = await mcpRequest("tools/call", {
    name: "generate_figma_design",
    arguments: { title: tab.title || "Web Capture" },
  });

  // 2. Extract captureId and endpoint from the response
  let captureId, endpoint;
  if (toolResult?.content) {
    for (const item of toolResult.content) {
      if (item.type === "text") {
        try {
          const parsed = JSON.parse(item.text);
          captureId = captureId || parsed.captureId;
          endpoint = endpoint || parsed.endpoint;
        } catch {
          // Try regex extraction as fallback
          const idMatch = item.text.match(/captureId["'\s:]+([a-zA-Z0-9_-]+)/);
          const epMatch = item.text.match(/endpoint["'\s:]+(https?:\/\/[^\s"']+)/);
          if (idMatch) captureId = captureId || idMatch[1];
          if (epMatch) endpoint = endpoint || epMatch[1];
        }
      }
    }
  }

  if (!captureId || !endpoint) {
    throw new Error(
      "Could not get capture config from Figma. Response: " +
        JSON.stringify(toolResult).slice(0, 200)
    );
  }

  // 3. Fetch Figma capture script
  const scriptResp = await fetch(
    `${MCP_BASE}/mcp/html-to-design/capture.js`
  );
  if (!scriptResp.ok) throw new Error("Failed to fetch Figma capture script");
  const scriptText = await scriptResp.text();

  // 4. Inject the script into the page
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

  // 5. Trigger capture
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
        // Retry once on auth expiry
        if (err.message === "AUTH_EXPIRED") {
          try {
            resetMcpSession();
            const [tab] = await chrome.tabs.query({
              active: true,
              currentWindow: true,
            });
            const result = await handleCapture(tab);
            sendResponse(result);
            return;
          } catch (retryErr) {
            sendResponse({ success: false, error: retryErr.message });
            return;
          }
        }
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // keep channel open for async
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
      [
        "figmaAccessToken",
        "figmaRefreshToken",
        "figmaTokenExpiry",
        "figmaClientId",
      ],
      () => {
        resetMcpSession();
        sendResponse({ success: true });
      }
    );
    return true;
  }
});
