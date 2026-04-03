const NATIVE_HOST = "com.web_to_figma.capture";

let captureState = { active: false, step: 0 };

function sendProgress(step, error) {
  captureState = { active: !error && step < 3, step, error: error || null };
  chrome.runtime.sendMessage({ action: "capture-progress", step, error: error || null }).catch(() => {});
}

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
  // Step 1: Call native host → Claude Code → Figma MCP
  sendProgress(1);
  const { captureId, endpoint } = await callNativeHost({
    action: "generate-capture",
    title: tab.title || "Web Capture",
  });

  // Step 2: Fetch and inject Figma capture script
  sendProgress(2);
  const scriptResp = await fetch(
    "https://mcp.figma.com/mcp/html-to-design/capture.js"
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

  // Step 3: Overlay appears the moment captureForDesign is called
  sendProgress(3);
  setTimeout(() => { captureState = { active: false, step: 0 }; }, 5000);

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
  if (message.action === "capture-status") {
    sendResponse(captureState);
    return false;
  }

  if (message.action === "capture") {
    sendResponse({ started: true });
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab) throw new Error("No active tab found");
        await handleCapture(tab);
      } catch (err) {
        sendProgress(0, err.message);
      }
    })();
    return true;
  }
});
