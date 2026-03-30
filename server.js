const express = require("express");
const { chromium } = require("playwright");

const PORT = process.env.PORT || 3131;

let browser = null;
let context = null;
let page = null;

// Stored capture config (set by Claude Code, consumed by Chrome extension)
let pendingCaptureConfig = null;

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
