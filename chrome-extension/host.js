#!/usr/bin/env node

const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const LOG_PATH = path.join(os.homedir(), ".web-to-figma-host.log");

function log(level, msg) {
  try {
    const ts = new Date().toISOString();
    fs.appendFileSync(LOG_PATH, `${ts} ${level} ${msg}\n`);
  } catch {}
}

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(header);
  process.stdout.write(json);
}

process.on("uncaughtException", (err) => {
  log("ERROR", `Uncaught exception: ${err.message}`);
  sendMessage({ error: `Host crash: ${err.message}` });
  process.exit(1);
});

function findClaude() {
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  // Fall back to PATH
  try {
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  } catch {}
  return null;
}

function clearNodeQuarantine() {
  if (process.platform !== "darwin") return false;
  let cleared = false;
  try {
    const tmpdir = os.tmpdir();
    const entries = fs.readdirSync(tmpdir);
    for (const entry of entries) {
      if (!entry.endsWith(".node")) continue;
      const fullPath = path.join(tmpdir, entry);
      try {
        const result = execFileSync("xattr", ["-l", fullPath], {
          encoding: "utf8",
          timeout: 5000,
        });
        if (result.includes("com.apple.quarantine")) {
          execFileSync("xattr", ["-d", "com.apple.quarantine", fullPath], {
            timeout: 5000,
          });
          cleared = true;
          log("INFO", `Cleared quarantine from ${fullPath}`);
        }
      } catch {}
    }
  } catch {}
  return cleared;
}

function loadSkillsContext() {
  const skillsDir = path.join(__dirname, "skills");
  const files = [
    "figma-use/SKILL.md",
    "figma-generate-design/SKILL.md",
    "figma-use/references/gotchas.md",
    "figma-use/references/common-patterns.md",
    "figma-use/references/variable-patterns.md",
    "figma-use/references/component-patterns.md",
    "figma-use/references/validation-and-recovery.md",
  ];
  const parts = [];
  for (const f of files) {
    const filePath = path.join(skillsDir, f);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      parts.push(`--- ${f} ---\n${content}`);
    } catch {}
  }
  return parts.join("\n\n");
}

function extractConfig(text) {
  if (typeof text !== "string") text = JSON.stringify(text);
  const m = text.match(/\{[^{}]*"captureId"[^{}]*\}/);
  if (m) {
    try {
      const p = JSON.parse(m[0]);
      if (p.captureId && p.endpoint) return p;
    } catch {}
  }
  const id = text.match(/captureId["'\s:]+([a-zA-Z0-9_-]+)/);
  const ep = text.match(/endpoint["'\s:]+(https?:\/\/[^\s"']+)/);
  if (id?.[1] && ep?.[1]) return { captureId: id[1], endpoint: ep[1] };
  // Fallback: extract from figmacapture URL format
  const fc = text.match(/figmacapture=([a-zA-Z0-9_-]+)/);
  const fe = text.match(/figmaendpoint=(https?[^\s&"']+)/);
  if (fc?.[1] && fe?.[1])
    return { captureId: fc[1], endpoint: decodeURIComponent(fe[1]) };
  return { captureId: id?.[1] || null, endpoint: ep?.[1] || null };
}

function runClaude(cmd, timeout, callback) {
  clearNodeQuarantine();

  execFile(cmd[0], cmd.slice(1), { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && err.returnCode !== 0 && clearNodeQuarantine()) {
      log("INFO", "Retrying after clearing quarantine from .node files");
      execFile(cmd[0], cmd.slice(1), { timeout, maxBuffer: 1024 * 1024 }, (err2, stdout2, stderr2) => {
        callback(err2, stdout2, stderr2);
      });
      return;
    }
    callback(err, stdout, stderr);
  });
}

// Read one native messaging message (don't wait for stdin to close)
process.stdin.once("readable", () => {
  const lenBuf = process.stdin.read(4);
  if (!lenBuf) {
    sendMessage({ error: "No data" });
    process.exit(1);
  }
  const len = lenBuf.readUInt32LE(0);
  const bodyBuf = process.stdin.read(len);
  if (!bodyBuf) {
    sendMessage({ error: "Incomplete message" });
    process.exit(1);
  }

  let message;
  try {
    message = JSON.parse(bodyBuf.toString());
  } catch (e) {
    sendMessage({ error: `Bad JSON: ${e.message}` });
    process.exit(1);
  }

  handleMessage(message);
});

function handleMessage(message) {
  log("INFO", "Host started");
  log("INFO", `Message received: ${JSON.stringify(message)}`);

  if (message.action !== "generate-capture") {
    sendMessage({ error: `Unknown action: ${message.action}` });
    return process.exit(0);
  }

  const claude = findClaude();
  log("INFO", `Claude CLI path: ${claude}`);
  if (!claude) {
    sendMessage({
      error: "Claude Code not found. Install from https://claude.ai/code",
    });
    return process.exit(0);
  }

  const safeTitle = (message.title || "Web Capture").replace(/"/g, '\\"');
  const fileUrl = message.fileUrl || "";
  const useDesignSystem = message.useDesignSystem || false;

  let prompt;
  let allowedTools = "mcp__figma__generate_figma_design,mcp__figma__get_metadata";
  let timeout = 90000;
  let systemContext = "";

  if (useDesignSystem && fileUrl) {
    prompt =
      `Build a simple layout in the Figma file at "${fileUrl}" inspired by ` +
      `the web page titled "${safeTitle}".\n\n` +
      "Do this in exactly 3 steps, no more:\n" +
      '1. Call search_design_system once with query "button card input nav" ' +
      "to find available components. Note the component keys.\n" +
      "2. Call use_figma once to create a frame and add instances of the most " +
      "relevant components found. Import components by key using " +
      "figma.importComponentSetByKeyAsync(key), create instances, and arrange " +
      "them in a vertical auto-layout frame. Return all created node IDs.\n" +
      '3. Return {"status": "complete"} when done.\n\n' +
      "Keep it simple — just demonstrate using the design system components. " +
      "Do not search multiple times. Do not validate with screenshots. " +
      "Do not ask for confirmation. Do not open URLs in a browser. " +
      "If asked to choose an organization or team, select the first one available.";
    allowedTools =
      "mcp__figma__use_figma,mcp__figma__search_design_system";
    systemContext = loadSkillsContext();
    timeout = 120000;
  } else if (fileUrl) {
    prompt =
      `Call the generate_figma_design tool with title "${safeTitle}" ` +
      `and pass the file_url parameter set to "${fileUrl}" ` +
      "so the capture goes into that existing file instead of creating a new one. " +
      "If asked to choose an organization or team, select the first one available. " +
      "Do not ask for confirmation or clarification. Do not open any URLs in a browser. " +
      "Return ONLY the JSON object containing captureId and endpoint. No other text.";
  } else {
    prompt =
      `Call the generate_figma_design tool to create a new capture with title "${safeTitle}". ` +
      "If asked to choose an organization or team, select the first one available. " +
      "Do not ask for confirmation or clarification. " +
      "Return ONLY the JSON object containing captureId and endpoint. No other text.";
  }

  const cmd = [
    claude, "-p", prompt,
    "--output-format", "json",
    "--allowedTools", allowedTools,
    "--disallowedTools", "Bash,Read,Write,Edit,Glob,Grep,Agent",
  ];
  if (useDesignSystem && systemContext) {
    cmd.push("--append-system-prompt", systemContext);
  }

  log("INFO", `Running: ${claude} -p ... (ds=${useDesignSystem}, timeout=${timeout})`);

  runClaude(cmd, timeout, (err, stdout, stderr) => {
    if (err) {
      log("ERROR", `Claude error: ${err.message}`);
      sendMessage({
        error:
          err.code === "ENOENT"
            ? "Claude Code not found. Install from https://claude.ai/code"
            : err.killed
              ? "Timed out. Try again."
              : `Claude error: ${err.message}`,
      });
      return process.exit(0);
    }

    log("INFO", `Claude exit code: 0`);
    log("DEBUG", `Claude stdout: ${(stdout || "").substring(0, 500)}`);
    if (stderr) log("DEBUG", `Claude stderr: ${stderr.substring(0, 500)}`);

    let text = stdout;
    try {
      const envelope = JSON.parse(stdout);
      text = envelope.result || envelope.content || JSON.stringify(envelope);
    } catch {}

    if (useDesignSystem) {
      log("INFO", `DS mode complete. Result: ${String(text).substring(0, 200)}`);
      sendMessage({ status: "complete" });
    } else {
      const config = extractConfig(text);
      log("INFO", `Extracted config: ${JSON.stringify(config)}`);
      if (config.captureId && config.endpoint) {
        sendMessage(config);
      } else {
        sendMessage({
          error:
            "Could not get captureId/endpoint. Is Figma MCP configured in Claude Code?",
        });
      }
    }
    process.exit(0);
  });
}
