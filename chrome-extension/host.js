#!/usr/bin/env node

// Chrome Native Messaging host for Web to Figma.
// Protocol: [4-byte LE length][JSON] in both directions.

const { execFile } = require("child_process");

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(header);
  process.stdout.write(json);
}

process.on("uncaughtException", (err) => {
  sendMessage({ error: `Host crash: ${err.message}` });
  process.exit(1);
});

// Read all of stdin (Chrome sends one message then closes)
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  try {
    const buf = Buffer.concat(chunks);
    const len = buf.readUInt32LE(0);
    const message = JSON.parse(buf.slice(4, 4 + len).toString());
    handleMessage(message);
  } catch (e) {
    sendMessage({ error: `Parse error: ${e.message}` });
    process.exit(1);
  }
});

function handleMessage(message) {
  if (message.action !== "generate-capture") {
    sendMessage({ error: `Unknown action: ${message.action}` });
    process.exit(0);
  }

  const safeTitle = (message.title || "Web Capture").replace(/"/g, '\\"');
  const prompt = `Call the generate_figma_design tool to create a new capture with title "${safeTitle}". Return ONLY the JSON object containing captureId and endpoint. No other text.`;

  execFile(
    "claude",
    ["-p", prompt, "--output-format", "json"],
    { timeout: 60000, maxBuffer: 1024 * 1024 },
    (err, stdout) => {
      if (err) {
        sendMessage({
          error: err.code === "ENOENT"
            ? "Claude Code not found. Install from https://claude.ai/code"
            : err.killed ? "Timed out (60s)." : `Claude error: ${err.message}`,
        });
        process.exit(0);
      }

      let text = stdout;
      try {
        const envelope = JSON.parse(stdout);
        text = envelope.result || envelope.content || JSON.stringify(envelope);
      } catch {}

      const { captureId, endpoint } = extractConfig(text);

      if (captureId && endpoint) {
        sendMessage({ captureId, endpoint });
      } else {
        sendMessage({ error: "Could not get captureId/endpoint. Is Figma MCP configured?" });
      }
      process.exit(0);
    }
  );
}

function extractConfig(text) {
  if (typeof text !== "string") text = JSON.stringify(text);
  const jsonMatch = text.match(/\{[^{}]*"captureId"[^{}]*\}/);
  if (jsonMatch) {
    try {
      const p = JSON.parse(jsonMatch[0]);
      if (p.captureId && p.endpoint) return p;
    } catch {}
  }
  const id = text.match(/captureId["'\s:]+([a-zA-Z0-9_-]+)/);
  const ep = text.match(/endpoint["'\s:]+(https?:\/\/[^\s"']+)/);
  return { captureId: id?.[1] || null, endpoint: ep?.[1] || null };
}
