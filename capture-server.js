const express = require("express");
const { execFile } = require("child_process");

const PORT = process.env.PORT || 3131;

function extractCaptureConfig(text) {
  if (typeof text !== "string") text = JSON.stringify(text);

  // Try to find a JSON object with captureId
  const jsonMatch = text.match(/\{[^{}]*"captureId"[^{}]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.captureId && parsed.endpoint) return parsed;
    } catch {}
  }

  // Regex fallback
  const idMatch = text.match(/captureId["'\s:]+([a-zA-Z0-9_-]+)/);
  const epMatch = text.match(/endpoint["'\s:]+(https?:\/\/[^\s"']+)/);
  return {
    captureId: idMatch?.[1] || null,
    endpoint: epMatch?.[1] || null,
  };
}

const app = express();
app.use(express.json());

// CORS for Chrome extension
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});
app.options("*", (_req, res) => res.sendStatus(204));

app.get("/status", (_req, res) => {
  res.json({ ok: true });
});

app.post("/generate-capture", (req, res) => {
  const { title } = req.body;
  const safeTitle = (title || "Web Capture").replace(/"/g, '\\"');

  const prompt = [
    `Call the generate_figma_design tool to create a new capture with title "${safeTitle}".`,
    "Return ONLY the JSON object containing captureId and endpoint. No other text.",
  ].join(" ");

  console.log(`Generating capture for: ${safeTitle}`);

  execFile(
    "claude",
    ["-p", prompt, "--output-format", "json"],
    { timeout: 60000, maxBuffer: 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) {
        if (err.code === "ENOENT") {
          return res.status(500).json({
            error:
              "Claude Code CLI not found. Install from https://claude.ai/code",
          });
        }
        return res.status(500).json({
          error: err.killed
            ? "Claude timed out (60s). Try again."
            : `Claude failed: ${err.message}`,
          stderr,
        });
      }

      // Parse claude's output — may be JSON envelope or plain text
      let text = stdout;
      try {
        const envelope = JSON.parse(stdout);
        text = envelope.result || envelope.content || JSON.stringify(envelope);
      } catch {}

      const { captureId, endpoint } = extractCaptureConfig(text);

      if (captureId && endpoint) {
        console.log(`Capture ready (captureId: ${captureId.slice(0, 8)}...)`);
        res.json({ captureId, endpoint });
      } else {
        console.error("Could not parse claude output:", stdout.slice(0, 300));
        res.status(500).json({
          error:
            "Could not extract captureId/endpoint from Claude's response. Is the Figma MCP configured?",
          raw: stdout.slice(0, 500),
        });
      }
    }
  );
});

app.listen(PORT, () => {
  console.log(`Capture server running on http://localhost:${PORT}`);
  console.log("");
  console.log("Endpoints:");
  console.log("  GET  /status           - health check");
  console.log(
    "  POST /generate-capture - { title } → calls Claude + Figma MCP"
  );
  console.log("");
  console.log(
    'Requires: Claude Code CLI with Figma MCP configured (claude mcp add --transport http figma https://mcp.figma.com/mcp)'
  );
});
