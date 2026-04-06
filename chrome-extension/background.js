const NATIVE_HOST = "com.web_to_figma.capture";
const DS_DAEMON_URL = "http://localhost:19615";

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

async function callDsDaemon(message, onProgress) {
  // Check if daemon is running
  try {
    const health = await fetch(`${DS_DAEMON_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!health.ok) throw new Error();
  } catch {
    throw new Error("Design system daemon not running. Re-run the install script in your terminal.");
  }

  // Start the job (returns immediately)
  const startResp = await fetch(`${DS_DAEMON_URL}/ds-capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  const startData = await startResp.json();
  if (startData.error) throw new Error(startData.error);

  // Poll for completion every 3 seconds
  const jobId = startData.id;
  const startTime = Date.now();
  while (true) {
    await new Promise((r) => setTimeout(r, 3000));
    if (onProgress) onProgress(Date.now() - startTime);

    const statusResp = await fetch(`${DS_DAEMON_URL}/status`);
    const statusData = await statusResp.json();

    if (statusData.id !== jobId) throw new Error("Job was replaced");

    if (statusData.status === "complete") {
      if (statusData.result?.error) throw new Error(statusData.result.error);
      return statusData.result;
    }
  }
}

async function capturePageStructure(tabId) {
  const [structResult] = await chrome.scripting.executeScript({
    target: { tabId },
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
      const seen = new Set();
      return items.filter((item) => {
        const key = item.tag + ":" + item.text;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 50);
    },
    world: "MAIN",
  });
  return structResult?.result || [];
}

async function handleCapture(tab, options = {}) {
  const dsMode = options.useDesignSystem || false;
  totalSteps = dsMode ? 6 : 3;
  captureState.dsMode = dsMode;

  sendProgress(1);

  if (dsMode) {
    // DS mode: use localhost daemon (avoids browser quarantine / Gatekeeper)
    const pageStructure = await capturePageStructure(tab.id);
    const dsMsg = {
      title: tab.title || "Web Capture",
      fileUrl: options.fileUrl,
      pageStructure,
    };

    // Progress is driven by polling — advance steps on a schedule
    // but jump to step 6 the instant the job completes.
    sendProgress(2);
    const result = await callDsDaemon(dsMsg, (elapsedMs) => {
      // Called every poll cycle with elapsed time
      if (elapsedMs > 120000) sendProgress(5);
      else if (elapsedMs > 30000) sendProgress(4);
      else if (elapsedMs > 10000) sendProgress(3);
    });

    sendProgress(6);
  } else {
    // Standard mode: native messaging + client-side Figma capture
    const hostMsg = {
      action: "generate-capture",
      title: tab.title || "Web Capture",
    };
    if (options.fileUrl) hostMsg.fileUrl = options.fileUrl;

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

// Register uninstall URL — daemon cleans up when extension is removed
chrome.runtime.setUninstallURL(`${DS_DAEMON_URL}/uninstall`);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "capture-status") {
    sendResponse(captureState);
    return false;
  }

  if (message.action === "set-config") {
    callNativeHost({ action: "set-config", provider: message.provider })
      .then((resp) => sendResponse(resp))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "detect-provider") {
    callNativeHost({ action: "detect-provider" })
      .then((resp) => sendResponse(resp))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
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
