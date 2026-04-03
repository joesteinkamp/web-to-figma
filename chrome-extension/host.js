#!/usr/bin/env node

// Chrome Native Messaging host for Web to Figma.
// Chrome spawns this process on demand, sends a JSON message, and reads the response.
// Protocol: [4-byte little-endian length][JSON payload]

const { execFile } = require("child_process");
const os = require("os");

// Chrome spawns native hosts with a limited PATH. Add common install locations.
const extraPaths = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  `${os.homedir()}/.local/bin`,
  `${os.homedir()}/.nvm/versions/node`,
  "/usr/bin",
  "/bin",
];
process.env.PATH = `${process.env.PATH || ""}:${extraPaths.join(":")}`;

// Catch any unhandled errors so we can report them
process.on("uncaughtException", (err) => {
  sendMessage({ error: `Host crash: ${err.message}` });
  process.exit(1);
});

function readMessage() {
  return new Promise((resolve, reject) => {
    const header = Buffer.alloc(4);
    let headerBytesRead = 0;

    function onReadable() {
      // Read the 4-byte header
      if (headerBytesRead < 4) {
        const chunk = process.stdin.read(4 - headerBytesRead);
        if (!chunk) return;
        chunk.copy(header, headerBytesRead);
        headerBytesRead += chunk.length;
      }

      if (headerBytesRead === 4) {
        const messageLength = header.readUInt32LE(0);
        const body = process.stdin.read(messageLength);
        if (!body) return;
        process.stdin.removeListener("readable", onReadable);
        try {
          resolve(JSON.parse(body.toString()));
        } catch (e) {
          reject(new Error("Invalid JSON message"));
        }
      }
    }

    process.stdin.on("readable", onReadable);
    process.stdin.on("end", () => reject(new Error("stdin closed")));
  });
}

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(header);
  process.stdout.write(json);
}

function extractCaptureConfig(text) {
  if (typeof text !== "string") text = JSON.stringify(text);

  const jsonMatch = text.match(/\{[^{}]*"captureId"[^{}]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.captureId && parsed.endpoint) return parsed;
    } catch {}
  }

  const idMatch = text.match(/captureId["'\s:]+([a-zA-Z0-9_-]+)/);
  const epMatch = text.match(/endpoint["'\s:]+(https?:\/\/[^\s"']+)/);
  return {
    captureId: idMatch?.[1] || null,
    endpoint: epMatch?.[1] || null,
  };
}

async function main() {
  const message = await readMessage();

  if (message.action !== "generate-capture") {
    sendMessage({ error: `Unknown action: ${message.action}` });
    process.exit(0);
  }

  const safeTitle = (message.title || "Web Capture").replace(/"/g, '\\"');
  const prompt = [
    `Call the generate_figma_design tool to create a new capture with title "${safeTitle}".`,
    "Return ONLY the JSON object containing captureId and endpoint. No other text.",
  ].join(" ");

  execFile(
    "claude",
    ["-p", prompt, "--output-format", "json"],
    { timeout: 60000, maxBuffer: 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) {
        if (err.code === "ENOENT") {
          sendMessage({ error: "Claude Code CLI not found. Install from https://claude.ai/code" });
        } else {
          sendMessage({
            error: err.killed
              ? "Claude timed out (60s). Try again."
              : `Claude failed: ${err.message}`,
          });
        }
        process.exit(0);
      }

      let text = stdout;
      try {
        const envelope = JSON.parse(stdout);
        text = envelope.result || envelope.content || JSON.stringify(envelope);
      } catch {}

      const { captureId, endpoint } = extractCaptureConfig(text);

      if (captureId && endpoint) {
        sendMessage({ captureId, endpoint });
      } else {
        sendMessage({
          error: "Could not extract captureId/endpoint. Is the Figma MCP configured in Claude Code?",
          raw: stdout.slice(0, 300),
        });
      }
      process.exit(0);
    }
  );
}

main().catch((err) => {
  sendMessage({ error: err.message });
  process.exit(1);
});
