const NATIVE_HOST = "com.web_to_figma.capture";

let captureState = { active: false, step: 0, dsMode: false };
let totalSteps = 3;

function sendProgress(step, error) {
  captureState = { active: !error && step < totalSteps, step, error: error || null, dsMode: captureState.dsMode };
  chrome.runtime.sendMessage({ action: "capture-progress", step, error: error || null, dsMode: captureState.dsMode }).catch(() => {});
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
  captureState.dsMode = dsMode;

  // All real work starts immediately in parallel
  sendProgress(1);
  const hostMsg = {
    action: "generate-capture",
    title: tab.title || "Web Capture",
  };
  if (options.fileUrl) hostMsg.fileUrl = options.fileUrl;
  if (dsMode) hostMsg.useDesignSystem = true;

  // For DS mode, capture the page structure so Claude knows what to build
  if (dsMode) {
    const [structResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        function isVisible(el) {
          if (!el.offsetParent && el.tagName !== "BODY" && el.tagName !== "HTML") return false;
          const style = getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        }
        const els = document.querySelectorAll("h1,h2,h3,h4,nav,header,footer,main,section,form,button,input,a,img,table");
        const items = [];
        els.forEach((el) => {
          if (!isVisible(el)) return;
          const tag = el.tagName.toLowerCase();
          const text = el.textContent?.trim().slice(0, 80) || "";
          const role = el.getAttribute("role") || "";
          const placeholder = el.getAttribute("placeholder") || "";
          if (text || role || placeholder) {
            items.push({ tag, text, role, placeholder: placeholder || undefined });
          }
        });
        return items.slice(0, 100);
      },
      world: "MAIN",
    });
    if (structResult?.result) {
      hostMsg.pageStructure = structResult.result;
    }
  }

  // DS mode works entirely via MCP tools — no client-side capture needed
  const workDone = dsMode
    ? callNativeHost(hostMsg)
    : Promise.all([
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
    // DS mode: no overlay needed — work happens entirely via MCP tools
    // (search_design_system + use_figma). Run progress timers in parallel.
    let aborted = false;
    const progressTimer = (async () => {
      await new Promise((r) => setTimeout(r, 4000));
      if (!aborted) sendProgress(2); // "Connecting to Figma"
      await new Promise((r) => setTimeout(r, 10000));
      if (!aborted) sendProgress(3); // "Searching design system"
      await new Promise((r) => setTimeout(r, 30000));
      if (!aborted) sendProgress(4); // "Building with components"
      await new Promise((r) => setTimeout(r, 60000));
      if (!aborted) sendProgress(5); // "Finalizing design"
    })();

    try {
      await workDone;
    } catch (err) {
      aborted = true;
      throw err;
    }

    // Jump to final step once work is actually done
    aborted = true;
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

  setTimeout(() => { captureState = { active: false, step: 0, dsMode: false }; totalSteps = 3; }, 5000);
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
