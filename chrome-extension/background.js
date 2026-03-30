const NATIVE_HOST = "com.web_to_figma.capture";

function callNativeHost(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}

async function handleCapture(tab) {
  // 1. Call native host → Claude Code → Figma MCP
  const { captureId, endpoint } = await callNativeHost({
    action: "generate-capture",
    title: tab.title || "Web Capture",
  });

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
});
