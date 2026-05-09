const NATIVE_HOST = "com.web_to_figma.capture";
const DS_DAEMON_URL = "http://localhost:19615";

let captureState = { active: false, step: 0, dsMode: false };
let totalSteps = 3;

function notify(message, contextMessage) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Web to Figma",
      message,
      contextMessage,
    });
  } catch {}
}

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

// CSS properties to inline when flattening iframe DOM content.
const INLINE_STYLE_PROPERTIES = [
  "display", "position", "width", "height", "min-width", "min-height",
  "max-width", "max-height", "margin", "padding", "box-sizing", "overflow",
  "top", "right", "bottom", "left", "z-index", "float", "clear",
  "vertical-align",
  "flex-direction", "flex-wrap", "align-items", "justify-content", "gap",
  "flex-grow", "flex-shrink", "flex-basis", "align-self", "order",
  "grid-template-columns", "grid-template-rows", "grid-column", "grid-row",
  "font-family", "font-size", "font-weight", "font-style", "line-height",
  "text-align", "text-decoration", "text-transform", "letter-spacing",
  "white-space", "word-break", "color",
  "background-color", "background-image", "background-size",
  "background-position", "background-repeat", "border", "border-radius",
  "box-shadow", "opacity", "outline", "text-shadow", "transform",
  "visibility",
];

/**
 * Flatten iframe content into the parent page before Figma capture.
 * Uses chrome.webNavigation to enumerate frames, then chrome.scripting to
 * extract each iframe's DOM with inlined computed styles, and finally replaces
 * each <iframe> in the parent page with the extracted content.
 */
async function flattenIframesForCapture(tabId) {
  // Get all frames in the tab
  let frames;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {
    return; // webNavigation not available — skip
  }

  // Filter to child frames only (exclude the main frame, frameId 0)
  const childFrames = frames.filter((f) => f.frameId !== 0 && f.url && f.url !== "about:blank");
  if (childFrames.length === 0) return;

  console.log(`[iframe-flatten] Found ${childFrames.length} child frame(s)`);

  // Collect iframe bounding rects from the main frame so we can match them
  // to child frames by src URL.
  const [iframeInfo] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const iframes = document.querySelectorAll("iframe");
      return Array.from(iframes).map((iframe, idx) => {
        const rect = iframe.getBoundingClientRect();
        return {
          idx,
          src: iframe.src || "",
          width: rect.width,
          height: rect.height,
          visible: rect.width > 0 && rect.height > 0,
        };
      });
    },
    world: "MAIN",
  });

  const iframeRects = iframeInfo?.result || [];
  if (iframeRects.length === 0) return;

  // For each child frame, extract its DOM with inlined styles
  const extractions = []; // { idx, html }

  for (const childFrame of childFrames) {
    // Match to an iframe element by URL
    const match = iframeRects.find(
      (r) => r.visible && r.src && childFrame.url.startsWith(r.src.split("#")[0])
    );
    if (!match) continue;

    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [childFrame.frameId] },
        func: (props) => {
          const MAX_DEPTH = 50;
          function inlineStyles(el, depth) {
            if (depth > MAX_DEPTH || el.nodeType !== 1) return;
            const computed = window.getComputedStyle(el);
            for (const prop of props) {
              const value = computed.getPropertyValue(prop);
              if (value) el.style.setProperty(prop, value);
            }
            const base = document.baseURI;
            if (el.tagName === "IMG" && el.getAttribute("src")) {
              try { el.src = new URL(el.getAttribute("src"), base).href; } catch {}
            }
            if (el.tagName === "A" && el.getAttribute("href")) {
              try { el.href = new URL(el.getAttribute("href"), base).href; } catch {}
            }
            for (const child of el.children) inlineStyles(child, depth + 1);
          }
          if (!document.body) return null;
          inlineStyles(document.body, 0);
          return document.body.innerHTML;
        },
        args: [INLINE_STYLE_PROPERTIES],
        world: "MAIN",
      });

      if (result?.result) {
        extractions.push({ idx: match.idx, html: result.result, width: match.width, height: match.height });
      }
    } catch (err) {
      console.log(`[iframe-flatten] Failed to extract frame ${childFrame.frameId}: ${err.message}`);
    }
  }

  if (extractions.length === 0) return;

  // Replace iframes in the parent page with the extracted content
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (items) => {
      const iframes = document.querySelectorAll("iframe");
      // Process in reverse order so indices remain valid
      for (const { idx, html, width, height } of [...items].sort((a, b) => b.idx - a.idx)) {
        const iframe = iframes[idx];
        if (!iframe) continue;
        const container = document.createElement("div");
        container.style.cssText = `all:initial;display:block;width:${width}px;height:${height}px;overflow:hidden;`;
        container.innerHTML = html;
        iframe.parentNode.replaceChild(container, iframe);
      }
    },
    args: [extractions],
    world: "MAIN",
  });

  console.log(`[iframe-flatten] Replaced ${extractions.length} iframe(s) with flattened DOM`);
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
    notify("Design ready in Figma", "Open the linked file to see the result.");
  } else {
    // Standard mode: native messaging + client-side Figma capture
    const hostMsg = {
      action: "generate-capture",
      title: tab.title || "Web Capture",
    };
    if (options.fileUrl) hostMsg.fileUrl = options.fileUrl;

    // Flatten iframe content into parent DOM before capture
    await flattenIframesForCapture(tab.id).catch((err) =>
      console.log(`[iframe-flatten] Skipped: ${err.message}`)
    );

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

    let attempts = 3;
    let lastError = null;

    // Kick off captureForDesign and treat a successful *call* (no sync throw,
    // script is initialized) as "overlay ready". The promise it returns is not
    // awaited — the overlay drives its own UI on the page, and waiting for it
    // to resolve is unreliable: the popup closes on focus loss the moment the
    // user looks at the overlay, so we'd never deliver step 3 in time anyway.
    while (attempts > 0) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (cid, ep) => {
            if (!window.figma || !window.figma.captureForDesign) {
              throw new Error("Figma capture script did not initialize");
            }
            const p = window.figma.captureForDesign({
              captureId: cid,
              endpoint: ep,
              selector: "body",
            });
            if (p && typeof p.catch === "function") p.catch(() => {});
          },
          args: [captureId, endpoint],
          world: "MAIN",
        });
        lastError = null;
        break; // Success
      } catch (err) {
        lastError = err;
        attempts--;
        if (attempts > 0) {
          console.warn(`Figma capture failed, retrying... (${attempts} left)`, err);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    if (lastError) {
      throw new Error(`Figma capture failed: ${lastError.message}`);
    }

    sendProgress(3);
    notify("Capture ready in Figma", "Click “Open file” on the page overlay.");
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
        notify("Capture failed", err.message);
      }
    })();
    return true;
  }
});
