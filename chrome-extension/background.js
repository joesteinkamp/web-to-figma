// Figma remote MCP server
const MCP_BASE = "https://mcp.figma.com";
const MCP_URL = `${MCP_BASE}/mcp`;

// ─── Auth ───

async function getFigmaToken() {
  const { figmaPAT } = await chrome.storage.local.get(["figmaPAT"]);
  if (!figmaPAT) {
    throw new Error("NO_TOKEN");
  }
  return figmaPAT;
}

// ─── MCP Streamable HTTP Client ───

let mcpSessionId = null;
let mcpInitialized = false;
let mcpNextId = 1;

async function mcpRequest(method, params, isNotification = false) {
  const token = await getFigmaToken();
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

  if (resp.status === 401 || resp.status === 403) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Figma auth failed (${resp.status}). Check your Personal Access Token. ${text}`
    );
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
  mcpNextId = 1;
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
      "Could not get capture config from Figma. Response: " +
        JSON.stringify(toolResult).slice(0, 300)
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
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === "checkAuth") {
    chrome.storage.local.get(["figmaPAT"], (data) => {
      sendResponse({ authenticated: !!data.figmaPAT });
    });
    return true;
  }

  if (message.action === "saveToken") {
    chrome.storage.local.set({ figmaPAT: message.token }, () => {
      resetMcpSession();
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.action === "logout") {
    chrome.storage.local.remove(["figmaPAT"], () => {
      resetMcpSession();
      sendResponse({ success: true });
    });
    return true;
  }
});
