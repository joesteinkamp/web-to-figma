const DEFAULT_SERVER = "http://localhost:3131";

async function getServerUrl() {
  const { serverUrl } = await chrome.storage.local.get(["serverUrl"]);
  return serverUrl || DEFAULT_SERVER;
}

async function checkServer() {
  const serverUrl = await getServerUrl();
  try {
    const resp = await fetch(`${serverUrl}/status`, {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function handleCapture(tab) {
  const serverUrl = await getServerUrl();

  // 1. Call local server → Claude Code → Figma MCP
  const resp = await fetch(`${serverUrl}/generate-capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: tab.title || "Web Capture" }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: `Server error ${resp.status}` }));
    throw new Error(err.error || "Server request failed");
  }

  const { captureId, endpoint } = await resp.json();

  // 2. Fetch Figma capture script
  const scriptResp = await fetch(
    "https://mcp.figma.com/mcp/html-to-design/capture.js"
  );
  if (!scriptResp.ok) throw new Error("Failed to fetch Figma capture script");
  const scriptText = await scriptResp.text();

  // 3. Inject script into page
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
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === "checkServer") {
    checkServer().then((running) => sendResponse({ running }));
    return true;
  }
});
