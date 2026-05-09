// Two ways to obtain a Playwright Browser + BrowserContext:
//
//   launchHeaded()       - chromium.launch({ headless: false }) locally.
//                          Used when the user wants to drive the browser
//                          interactively (manual login, point-and-click).
//
//   launchHeadless(opts) - spawn an `agent-browser` child process exposing
//                          CDP on an ephemeral port, then connectOverCDP.
//                          Used for fully programmatic captures with
//                          credentials passed in.
//
// Both return { browser, context, child? } with the same downstream contract:
// callers get a Page they can drive identically.

const net = require("net");
const { spawn } = require("child_process");
const { chromium } = require("playwright");
const { installBypassCSPForContext } = require("./csp");

const AGENT_BROWSER_BIN = process.env.AGENT_BROWSER_BIN || "agent-browser";

async function launchHeaded() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    bypassCSP: true,
  });
  return { browser, context, child: null };
}

// Pick a free TCP port by binding to 0 and reading the assigned port.
function pickEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Poll DevTools discovery endpoint until agent-browser is ready to accept
// CDP connections.  Returns the websocket URL.
async function waitForCDPReady(port, { timeoutMs = 30000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const json = await res.json();
        if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `agent-browser CDP did not become ready within ${timeoutMs}ms` +
      (lastErr ? ` (last error: ${lastErr.message})` : "")
  );
}

function buildAgentBrowserArgs(port, opts) {
  const args = ["open", "about:blank", "--cdp", String(port)];
  if (opts.headed) args.push("--headed");
  if (opts.name) args.push("--session-name", opts.name);
  if (opts.profile) args.push("--profile", opts.profile);
  if (opts.statePath) args.push("--state", opts.statePath);
  if (opts.headers && Object.keys(opts.headers).length > 0) {
    args.push("--headers", JSON.stringify(opts.headers));
  }
  return args;
}

async function launchHeadless(opts = {}, { logPrefix = "ab" } = {}) {
  const port = await pickEphemeralPort();
  const args = buildAgentBrowserArgs(port, opts);

  const child = spawn(AGENT_BROWSER_BIN, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Drain stdout/stderr so the pipe never deadlocks; prefix with logPrefix
  // so concurrent sessions are distinguishable.
  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${logPrefix}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${logPrefix}] ${chunk}`);
  });

  // Fail fast: if the child errors out (ENOENT etc.) or exits before CDP
  // becomes ready, surface that immediately instead of waiting 30s.
  let earlyFailure = null;
  const earlyFailurePromise = new Promise((resolve) => {
    child.once("error", (err) => {
      earlyFailure = err;
      resolve();
    });
    child.once("exit", (code, signal) => {
      if (earlyFailure) return;
      earlyFailure = new Error(
        `agent-browser exited before CDP was ready (code=${code}, signal=${signal})`
      );
      resolve();
    });
  });

  let wsUrl;
  try {
    wsUrl = await Promise.race([
      waitForCDPReady(port),
      earlyFailurePromise.then(() => {
        throw earlyFailure;
      }),
    ]);
  } catch (err) {
    try {
      child.kill("SIGKILL");
    } catch {}
    throw new Error(
      `agent-browser failed to start on port ${port}: ${err.message}. ` +
        `Is the '${AGENT_BROWSER_BIN}' binary installed and on PATH? ` +
        `See https://github.com/vercel-labs/agent-browser`
    );
  }

  const browser = await chromium.connectOverCDP(wsUrl);
  const contexts = browser.contexts();
  const context =
    contexts.length > 0 ? contexts[0] : await browser.newContext();

  // bypassCSP option is a no-op on connectOverCDP — wire CDP-level bypass
  // for every existing and future page in this context.
  await installBypassCSPForContext(context);

  return { browser, context, child, cdpPort: port, cdpUrl: wsUrl };
}

module.exports = { launchHeaded, launchHeadless };
