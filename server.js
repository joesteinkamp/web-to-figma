const express = require("express");
const { chromium } = require("playwright");

const PORT = process.env.PORT || 3131;

let browser = null;
let context = null;
let page = null;

// Stored capture config (set by Claude Code, consumed by Chrome extension)
let pendingCaptureConfig = null;

// CSS properties to inline when flattening iframe DOM into the parent page.
// This whitelist covers layout, text, and visual properties that Figma's
// capture script needs to reconstruct editable design nodes.
const INLINE_STYLE_PROPERTIES = [
  // Layout
  "display", "position", "width", "height", "min-width", "min-height",
  "max-width", "max-height", "margin", "padding", "box-sizing", "overflow",
  "top", "right", "bottom", "left", "z-index", "float", "clear",
  "vertical-align",
  // Flex / Grid
  "flex-direction", "flex-wrap", "align-items", "justify-content", "gap",
  "flex-grow", "flex-shrink", "flex-basis", "align-self", "order",
  "grid-template-columns", "grid-template-rows", "grid-column", "grid-row",
  // Text
  "font-family", "font-size", "font-weight", "font-style", "line-height",
  "text-align", "text-decoration", "text-transform", "letter-spacing",
  "white-space", "word-break", "color",
  // Visual
  "background-color", "background-image", "background-size",
  "background-position", "background-repeat", "border", "border-radius",
  "box-shadow", "opacity", "outline", "text-shadow", "transform",
  "visibility",
];

/**
 * Flatten iframe content into the parent page so Figma's capture script can
 * traverse it.  For each visible <iframe>, we extract its rendered DOM with
 * computed styles inlined, then replace the iframe element with a <div>
 * containing that content.  If DOM extraction fails (e.g. sandbox
 * restrictions), we fall back to a screenshot <img>.
 */
async function flattenIframesIntoPage(targetPage) {
  const iframes = await targetPage.$$("iframe");
  if (iframes.length === 0) return;

  console.log(`Found ${iframes.length} iframe(s) — flattening into parent DOM…`);
  let flattened = 0;
  let screenshotted = 0;

  for (const iframeHandle of iframes) {
    try {
      // Skip invisible / zero-size iframes
      const box = await iframeHandle.boundingBox();
      if (!box || box.width === 0 || box.height === 0) continue;

      const frame = await iframeHandle.contentFrame();
      if (!frame) {
        // No frame object — try screenshot fallback
        await replaceIframeWithScreenshot(targetPage, iframeHandle, box);
        screenshotted++;
        continue;
      }

      // Wait for the iframe to finish loading (best-effort, 5 s cap)
      await frame
        .waitForLoadState("domcontentloaded", { timeout: 5000 })
        .catch(() => {});

      // Extract the iframe's body HTML with computed styles inlined
      const extractedHTML = await frame.evaluate((props) => {
        const MAX_DEPTH = 50;

        function inlineStyles(el, depth) {
          if (depth > MAX_DEPTH) return;
          if (el.nodeType !== 1) return; // Element nodes only

          const computed = window.getComputedStyle(el);
          for (const prop of props) {
            const value = computed.getPropertyValue(prop);
            if (value) el.style.setProperty(prop, value);
          }

          // Resolve relative URLs to absolute
          const base = document.baseURI;
          if (el.tagName === "IMG" && el.getAttribute("src")) {
            try { el.src = new URL(el.getAttribute("src"), base).href; } catch {}
          }
          if (el.tagName === "A" && el.getAttribute("href")) {
            try { el.href = new URL(el.getAttribute("href"), base).href; } catch {}
          }
          // background-image url()
          const bgImg = computed.getPropertyValue("background-image");
          if (bgImg && bgImg !== "none" && bgImg.includes("url(")) {
            el.style.setProperty("background-image", bgImg);
          }

          for (const child of el.children) {
            inlineStyles(child, depth + 1);
          }
        }

        const body = document.body;
        if (!body) return null;

        // Inline styles on the live DOM (getComputedStyle requires connected
        // nodes), then serialize.  This mutates the iframe's DOM but we're
        // about to replace the iframe anyway.
        inlineStyles(body, 0);
        return body.innerHTML;
      }, INLINE_STYLE_PROPERTIES);

      if (!extractedHTML) {
        await replaceIframeWithScreenshot(targetPage, iframeHandle, box);
        screenshotted++;
        continue;
      }

      // Replace the <iframe> in the parent page with a <div> containing the
      // extracted content.  elementHandle.evaluate() runs in the context of
      // the element itself, so the first arg is the iframe DOM node.
      await iframeHandle.evaluate(
        (iframe, { html, width, height }) => {
          const container = document.createElement("div");
          container.style.cssText = `all:initial;display:block;width:${width}px;height:${height}px;overflow:hidden;`;
          container.innerHTML = html;
          iframe.parentNode.replaceChild(container, iframe);
        },
        { html: extractedHTML, width: box.width, height: box.height }
      );

      flattened++;
    } catch (err) {
      // Last resort: screenshot fallback
      try {
        const box = await iframeHandle.boundingBox().catch(() => null);
        if (box) {
          await replaceIframeWithScreenshot(targetPage, iframeHandle, box);
          screenshotted++;
        }
      } catch {
        // Skip this iframe entirely
      }
      console.log(`  ⚠ iframe flatten failed (${err.message}) — used fallback`);
    }
  }

  console.log(`  ✓ ${flattened} flattened via DOM, ${screenshotted} via screenshot`);
}

/**
 * Fallback: replace an iframe with a screenshot image.  Loses DOM structure
 * but at least preserves the visual appearance.
 */
async function replaceIframeWithScreenshot(targetPage, iframeHandle, box) {
  const buffer = await iframeHandle.screenshot({ type: "png" });
  const base64 = buffer.toString("base64");
  await iframeHandle.evaluate(
    (iframe, { src, width, height }) => {
      const img = document.createElement("img");
      img.src = src;
      img.style.cssText = `display:block;width:${width}px;height:${height}px;`;
      iframe.parentNode.replaceChild(img, iframe);
    },
    { src: `data:image/png;base64,${base64}`, width: box.width, height: box.height }
  );
}

async function main() {
  browser = await chromium.launch({ headless: false });

  // Set up CSP bypass at the context level — applies to ALL navigations automatically
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    bypassCSP: true,
  });

  page = await context.newPage();

  // Listen for new pages (e.g. user clicks target="_blank" links)
  context.on("page", (newPage) => {
    page = newPage;
    console.log(`Switched to new tab: ${newPage.url()}`);
  });

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // CORS: allow Chrome extension to call the server
  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    next();
  });
  app.options("*", (_req, res) => res.sendStatus(204));

  app.get("/status", (_req, res) => {
    res.json({
      ready: !!page,
      url: page ? page.url() : null,
    });
  });

  // Store capture config (called by Claude Code after getting captureId/endpoint from Figma MCP)
  app.post("/prepare-capture", (req, res) => {
    const { captureId, endpoint } = req.body;
    if (!captureId || !endpoint)
      return res.status(400).json({ error: "captureId and endpoint are required" });
    pendingCaptureConfig = { captureId, endpoint, createdAt: Date.now() };
    console.log(`Capture config stored (captureId: ${captureId.slice(0, 8)}...)`);
    res.json({ success: true });
  });

  // Retrieve stored capture config (called by Chrome extension)
  app.get("/capture-config", (_req, res) => {
    if (!pendingCaptureConfig) {
      return res.status(404).json({ error: "No capture config available. Ask Claude Code to prepare one." });
    }
    res.json(pendingCaptureConfig);
  });

  // Clear capture config after use
  app.delete("/capture-config", (_req, res) => {
    pendingCaptureConfig = null;
    res.json({ success: true });
  });

  app.post("/navigate", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      res.json({ success: true, url: page.url() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/inject", async (req, res) => {
    const { script } = req.body;
    if (!script) return res.status(400).json({ error: "script is required" });
    try {
      const result = await page.evaluate(script);
      res.json({ success: true, result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/capture-figma", async (req, res) => {
    const { captureId, endpoint } = req.body;
    if (!captureId || !endpoint)
      return res.status(400).json({ error: "captureId and endpoint are required" });
    try {
      // Flatten iframe content into the parent DOM so Figma's capture script
      // can see it (iframes are otherwise invisible to the script).
      await flattenIframesIntoPage(page);

      // Fetch capture script via Playwright's API (not from inside the page)
      const scriptResponse = await context.request.get(
        "https://mcp.figma.com/mcp/html-to-design/capture.js"
      );
      const scriptText = await scriptResponse.text();

      // Inject script into the current page
      await page.evaluate((s) => {
        const el = document.createElement("script");
        el.textContent = s;
        document.head.appendChild(el);
      }, scriptText);

      await page.waitForTimeout(1000);

      // Trigger capture — this may destroy the execution context (that's OK)
      const result = await page.evaluate(
        ({ captureId, endpoint }) =>
          window.figma.captureForDesign({ captureId, endpoint, selector: "body" }),
        { captureId, endpoint }
      ).catch((err) => {
        // "Execution context was destroyed" means capture submitted and page navigated — success
        if (err.message.includes("Execution context was destroyed")) {
          return { success: true, note: "Page navigated after capture submission" };
        }
        throw err;
      });

      res.json({ success: true, result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/screenshot", async (_req, res) => {
    try {
      const buffer = await page.screenshot({ fullPage: true });
      res.json({ success: true, image: buffer.toString("base64") });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/close", async (_req, res) => {
    res.json({ success: true });
    await shutdown();
  });

  const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log("Browser launched with CSP bypass enabled.");
    console.log("Browse freely — then call POST /capture-figma when ready.");
    console.log("");
    console.log("Endpoints:");
    console.log("  GET  /status          - current page URL");
    console.log("  POST /prepare-capture - { captureId, endpoint } store config for Chrome extension");
    console.log("  GET  /capture-config  - retrieve stored config (used by Chrome extension)");
    console.log("  POST /navigate        - { url } open a page");
    console.log("  POST /inject          - { script } run JS in page");
    console.log("  POST /capture-figma   - { captureId, endpoint } capture to Figma");
    console.log("  POST /screenshot      - full-page screenshot as base64");
    console.log("  POST /close           - shut down");
  });

  async function shutdown() {
    console.log("\nShutting down...");
    if (browser) await browser.close().catch(() => {});
    server.close(() => process.exit(0));
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start:", err.message);
  process.exit(1);
});
