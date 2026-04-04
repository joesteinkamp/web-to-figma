const NATIVE_HOST = "com.web_to_figma.capture";

let captureState = { active: false, step: 0 };
let totalSteps = 3;

function sendProgress(step, error) {
  captureState = { active: !error && step < totalSteps, step, error: error || null };
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

async function handleCapture(tab, options = {}) {
  const dsMode = options.useDesignSystem || false;
  totalSteps = dsMode ? 6 : 3;

  // All real work starts immediately in parallel
  sendProgress(1);
  const hostMsg = {
    action: "generate-capture",
    title: tab.title || "Web Capture",
  };
  if (options.fileUrl) hostMsg.fileUrl = options.fileUrl;
  if (dsMode) hostMsg.useDesignSystem = true;

  const workDone = Promise.all([
    callNativeHost(hostMsg),
    fetch("https://mcp.figma.com/mcp/html-to-design/capture.js")
      .then((r) => { if (!r.ok) throw new Error("Failed to fetch Figma capture script"); return r.text(); })
      .then((scriptText) => chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (code) => {
          const el = document.createElement("script");
          el.textContent = code;
          document.head.appendChild(el);
        },
        args: [scriptText],
        world: "MAIN",
      })),
  ]);

  if (dsMode) {
    // DS mode: run time-based progress steps in parallel with native host work
    // The native host does all 4 steps in one call, so we show estimated progress
    const progressTimer = (async () => {
      await new Promise((r) => setTimeout(r, 4000));
      sendProgress(2); // "Figma capture overlay loading"
      await new Promise((r) => setTimeout(r, 8000));
      sendProgress(3); // "Overlay ready"
      await new Promise((r) => setTimeout(r, 10000));
      sendProgress(4); // "Searching design system"
      await new Promise((r) => setTimeout(r, 30000));
      sendProgress(5); // "Building with components"
    })();

    // Wait for the native host to finish all steps
    const [{ captureId, endpoint }] = await workDone;

    // Fire captureForDesign
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (cid, ep) => {
        if (!window.figma || !window.figma.captureForDesign) {
          throw new Error("Figma capture script did not initialize");
        }
        window.figma.captureForDesign({
          captureId: cid,
          endpoint: ep,
          selector: "body",
        });
      },
      args: [captureId, endpoint],
      world: "MAIN",
    });

    // Jump to final step once work is actually done
    sendProgress(6); // "Design ready in Figma"
  } else {
    // Standard mode: original timing
    await new Promise((r) => setTimeout(r, 4000));
    sendProgress(2);

    const [{ captureId, endpoint }] = await workDone;

    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (cid, ep) => {
        if (!window.figma || !window.figma.captureForDesign) {
          throw new Error("Figma capture script did not initialize");
        }
        window.figma.captureForDesign({
          captureId: cid,
          endpoint: ep,
          selector: "body",
        });
      },
      args: [captureId, endpoint],
      world: "MAIN",
    });

    sendProgress(3);
  }

  setTimeout(() => { captureState = { active: false, step: 0 }; totalSteps = 3; }, 5000);
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
        await handleCapture(tab, { fileUrl: message.fileUrl, useDesignSystem: message.useDesignSystem });
      } catch (err) {
        sendProgress(0, err.message);
      }
    })();
    return true;
  }
});
