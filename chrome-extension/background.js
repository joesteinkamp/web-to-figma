chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "capture") {
    handleCapture(message.captureId, message.endpoint)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // keep message channel open for async response
  }
});

async function handleCapture(captureId, endpoint) {
  // 1. Get active tab
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab) {
    throw new Error("No active tab found");
  }

  // 2. Fetch Figma capture script
  const resp = await fetch(
    "https://mcp.figma.com/mcp/html-to-design/capture.js"
  );
  if (!resp.ok) {
    throw new Error(`Failed to fetch capture script: ${resp.status}`);
  }
  const scriptText = await resp.text();

  // 3. Inject the capture script into the page (world: "MAIN" bypasses CSP)
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

  // 4. Wait for the script to initialize
  await new Promise((r) => setTimeout(r, 1000));

  // 5. Call captureForDesign
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (captureId, endpoint) => {
      if (!window.figma || !window.figma.captureForDesign) {
        throw new Error("Figma capture script did not initialize");
      }
      return window.figma.captureForDesign({
        captureId,
        endpoint,
        selector: "body",
      });
    },
    args: [captureId, endpoint],
    world: "MAIN",
  });

  return { success: true, result: results[0]?.result };
}
