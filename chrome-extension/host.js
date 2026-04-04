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
  const fileUrl = message.fileUrl || "";
  const useDesignSystem = message.useDesignSystem || false;

  let prompt;
  let allowedTools = "mcp__figma__generate_figma_design,mcp__figma__get_metadata";
  let timeout = 60000;

  if (useDesignSystem && fileUrl) {
    prompt = `Capture the web page titled "${safeTitle}" using design system components. Use the Figma file URL "${fileUrl}" so captures go to that existing file. Follow this workflow:\n1. Call generate_figma_design to create a capture into the file as a flat reference.\n2. Use search_design_system to find matching components, variables, and styles in the file's libraries. Search for common UI elements: buttons, inputs, cards, navigation, headers, footers, icons, avatars, toggles, tags, etc.\n3. Use use_figma to create a new frame in the file that rebuilds the page layout using real component instances, variable bindings for colors and spacing, and proper auto layout structure. Work section by section.\n4. Delete the flat capture reference frame when the component-based version is complete.\nIf asked to choose an organization or team, select the first one available. Do not ask for confirmation or clarification. Return ONLY the JSON object containing captureId and endpoint. No other text.`;
    allowedTools = "mcp__figma__generate_figma_design,mcp__figma__get_metadata,mcp__figma__use_figma,mcp__figma__search_design_system,mcp__figma__get_screenshot,mcp__figma__get_variable_defs";
    timeout = 300000;
  } else if (fileUrl) {
    prompt = `Call the generate_figma_design tool to create a new capture with title "${safeTitle}". Use the Figma file URL "${fileUrl}" so the capture is added to that existing file. If asked to choose an organization or team, select the first one available. Do not ask for confirmation or clarification. Return ONLY the JSON object containing captureId and endpoint. No other text.`;
  } else {
    prompt = `Call the generate_figma_design tool to create a new capture with title "${safeTitle}". If asked to choose an organization or team, select the first one available. Do not ask for confirmation or clarification. Return ONLY the JSON object containing captureId and endpoint. No other text.`;
  }

  execFile(
    "claude",
    ["-p", prompt, "--output-format", "json", "--allowedTools", allowedTools],
    { timeout, maxBuffer: 1024 * 1024 },
    (err, stdout) => {
      if (err) {
        sendMessage({
          error: err.code === "ENOENT"
            ? "Claude Code not found. Install from https://claude.ai/code"
            : err.killed ? "Timed out. Try again." : `Claude error: ${err.message}`,
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
