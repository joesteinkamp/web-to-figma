#!/usr/bin/env node

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

// Read one native messaging message (don't wait for stdin to close)
process.stdin.once("readable", () => {
  const lenBuf = process.stdin.read(4);
  if (!lenBuf) { sendMessage({ error: "No data" }); process.exit(1); }
  const len = lenBuf.readUInt32LE(0);
  const bodyBuf = process.stdin.read(len);
  if (!bodyBuf) { sendMessage({ error: "Incomplete message" }); process.exit(1); }

  let message;
  try { message = JSON.parse(bodyBuf.toString()); }
  catch (e) { sendMessage({ error: `Bad JSON: ${e.message}` }); process.exit(1); }

  handleMessage(message);
});

function handleMessage(message) {
  if (message.action !== "generate-capture") {
    sendMessage({ error: `Unknown action: ${message.action}` });
    return process.exit(0);
  }

  const safeTitle = (message.title || "Web Capture").replace(/"/g, '\\"');
  const prompt = `Call the generate_figma_design tool to create a new capture with title "${safeTitle}". If asked to choose an organization or team, select the first one available. Do not ask for confirmation or clarification. Return ONLY the JSON object containing captureId and endpoint. No other text.`;

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
        return process.exit(0);
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
  const m = text.match(/\{[^{}]*"captureId"[^{}]*\}/);
  if (m) { try { const p = JSON.parse(m[0]); if (p.captureId && p.endpoint) return p; } catch {} }
  const id = text.match(/captureId["'\s:]+([a-zA-Z0-9_-]+)/);
  const ep = text.match(/endpoint["'\s:]+(https?:\/\/[^\s"']+)/);
  return { captureId: id?.[1] || null, endpoint: ep?.[1] || null };
}
