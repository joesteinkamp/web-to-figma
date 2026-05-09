// web-to-figma server: drives a Playwright Browser to capture pages into
// Figma via Figma's html-to-design capture script.
//
// Two modes:
//   - headed  (default): chromium.launch({ headless: false }) — user opens
//     pages in the visible window, logs in manually, then captures.
//   - headless (--headless / WEB_TO_FIGMA_MODE=headless): drives Vercel's
//     agent-browser via CDP.  Supports per-session credentials passed in the
//     POST /session body, persistent profiles, vault auth, etc.
//
// All driving endpoints accept an optional sessionId; if omitted, the
// "default" session is used (auto-created at startup in headed mode).

const express = require("express");
const { SessionManager, newSessionId, DEFAULT_SESSION_ID } = require("./lib/sessions");
const { captureToFigma } = require("./lib/capture");

const PORT = process.env.PORT || 3131;

function parseMode(argv, env) {
  if (argv.includes("--headless") || env.WEB_TO_FIGMA_MODE === "headless") {
    return "headless";
  }
  return "headed";
}

const MODE = parseMode(process.argv.slice(2), process.env);

// Stored capture config (set by Claude Code, consumed by Chrome extension).
// Server-wide, not session-scoped — the extension only knows about the local
// browser window, which only exists in headed mode.
let pendingCaptureConfig = null;

async function main() {
  const sessions = new SessionManager({ mode: MODE });

  // Headed mode: pre-create the default session so existing prompts that
  // don't pass a sessionId keep working.  Headless mode requires explicit
  // /session creation so callers can pass credentials.
  if (MODE === "headed") {
    await sessions.create(DEFAULT_SESSION_ID);
  }

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    next();
  });
  app.options("*", (_req, res) => res.sendStatus(204));

  // Resolve a sessionId from request, defaulting to "default".  Throws a
  // clean 404-able error if the session doesn't exist.
  function resolveSession(req) {
    const id = sessions.resolveId(req.body?.sessionId || req.query?.sessionId);
    return sessions.get(id);
  }

  app.get("/status", (_req, res) => {
    res.json({
      mode: MODE,
      sessions: sessions.list(),
    });
  });

  // ---- Session lifecycle ----------------------------------------------------

  app.post("/session", async (req, res) => {
    try {
      const {
        id: requestedId,
        name,
        headers,
        cookies,
        storageState,
        profile,
        statePath,
        loginUrl,
        headed,
      } = req.body || {};

      const id = requestedId || newSessionId();

      if (MODE === "headed" && (profile || statePath || headed)) {
        console.warn(
          `[session:${id}] ignoring agent-browser-only options (profile/statePath/headed) in headed mode`
        );
      }

      const session = await sessions.create(id, {
        name,
        headers,
        cookies,
        storageState,
        profile,
        statePath,
        loginUrl,
        headed,
      });
      res.json({
        sessionId: session.id,
        mode: session.mode,
        url: session.activePage.url(),
      });
    } catch (err) {
      console.error("Failed to create session:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/session/:id", async (req, res) => {
    const ok = await sessions.destroy(req.params.id);
    if (!ok) return res.status(404).json({ error: "Session not found" });
    res.json({ success: true });
  });

  app.get("/sessions", (_req, res) => {
    res.json({ sessions: sessions.list() });
  });

  // ---- Capture config (Chrome extension flow, headed only) ------------------

  app.post("/prepare-capture", (req, res) => {
    const { captureId, endpoint } = req.body;
    if (!captureId || !endpoint)
      return res.status(400).json({ error: "captureId and endpoint are required" });
    pendingCaptureConfig = { captureId, endpoint, createdAt: Date.now() };
    console.log(`Capture config stored (captureId: ${captureId.slice(0, 8)}...)`);
    res.json({ success: true });
  });

  app.get("/capture-config", (_req, res) => {
    if (!pendingCaptureConfig) {
      return res.status(404).json({
        error: "No capture config available. Ask Claude Code to prepare one.",
      });
    }
    res.json(pendingCaptureConfig);
  });

  app.delete("/capture-config", (_req, res) => {
    pendingCaptureConfig = null;
    res.json({ success: true });
  });

  // ---- Driving endpoints ----------------------------------------------------

  app.post("/navigate", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });
    try {
      const session = resolveSession(req);
      await session.activePage.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      res.json({
        success: true,
        sessionId: session.id,
        url: session.activePage.url(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/inject", async (req, res) => {
    const { script } = req.body;
    if (!script) return res.status(400).json({ error: "script is required" });
    try {
      const session = resolveSession(req);
      const result = await session.activePage.evaluate(script);
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
      const session = resolveSession(req);
      const result = await captureToFigma(session.activePage, {
        captureId,
        endpoint,
      });
      res.json({ success: true, sessionId: session.id, result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/screenshot", async (req, res) => {
    try {
      const session = resolveSession(req);
      const buffer = await session.activePage.screenshot({ fullPage: true });
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
    console.log(`Server running on http://localhost:${PORT} (mode: ${MODE})`);
    if (MODE === "headed") {
      console.log("Browser launched with CSP bypass enabled.");
      console.log("Browse freely — then call POST /capture-figma when ready.");
    } else {
      console.log(
        "Headless mode — POST /session to create a session (with optional credentials), then drive captures."
      );
      console.log(
        "Requires the 'agent-browser' CLI on PATH (https://github.com/vercel-labs/agent-browser)."
      );
    }
    console.log("");
    console.log("Endpoints:");
    console.log("  GET  /status            - server mode + session list");
    console.log("  POST /session           - { name?, headers?, cookies?, storageState?, profile?, statePath?, loginUrl?, headed? } create a session");
    console.log("  GET  /sessions          - list active sessions");
    console.log("  DELETE /session/:id     - close a session");
    console.log("  POST /prepare-capture   - { captureId, endpoint } store config for Chrome extension");
    console.log("  GET  /capture-config    - retrieve stored config (used by Chrome extension)");
    console.log("  POST /navigate          - { url, sessionId? } open a page");
    console.log("  POST /inject            - { script, sessionId? } run JS in page");
    console.log("  POST /capture-figma     - { captureId, endpoint, sessionId? } capture to Figma");
    console.log("  POST /screenshot        - { sessionId? } full-page screenshot as base64");
    console.log("  POST /close             - shut down");
  });

  async function shutdown() {
    console.log("\nShutting down...");
    await sessions.destroyAll();
    server.close(() => process.exit(0));
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start:", err.message);
  process.exit(1);
});
