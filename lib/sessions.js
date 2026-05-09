// SessionManager: owns the lifecycle of named browser sessions.
//
// In headed mode, sessions wrap a locally-launched Chromium.
// In headless mode, sessions wrap a connectOverCDP browser whose underlying
// process is an agent-browser child.
//
// A "default" session is created at server startup (in both modes for headed
// users; on first request in headless mode if no explicit /session created).
// All driving endpoints accept an optional sessionId; if omitted, "default"
// is used so the original prompt-driven workflow continues to work.

const crypto = require("crypto");
const { launchHeaded, launchHeadless } = require("./launchers");
const {
  setExtraHTTPHeaders,
  addCookies,
  applyStorageState,
} = require("./auth");

const DEFAULT_SESSION_ID = "default";

class SessionManager {
  constructor({ mode }) {
    this.mode = mode; // "headed" | "headless"
    this.sessions = new Map();
  }

  has(id) {
    return this.sessions.has(id);
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Unknown sessionId: ${id}`);
    }
    if (session.dead) {
      throw new Error(
        `Session ${id} is no longer alive: ${session.deathReason || "browser disconnected"}`
      );
    }
    return session;
  }

  // Returns the session's currently active page.  Active page rotates to
  // the most recently opened tab so user-initiated link clicks behave like
  // they did in the singleton-page world.
  getActivePage(id) {
    const session = this.get(id);
    return session.activePage;
  }

  list() {
    return Array.from(this.sessions.entries()).map(([id, s]) => ({
      id,
      url: s.activePage?.url() ?? null,
      dead: !!s.dead,
      deathReason: s.deathReason || null,
      mode: s.mode,
    }));
  }

  async create(id, opts = {}) {
    if (this.sessions.has(id)) {
      throw new Error(`Session already exists: ${id}`);
    }

    const launched =
      this.mode === "headless"
        ? await launchHeadless(
            {
              name: opts.name || id,
              headers: opts.headers,
              profile: opts.profile,
              statePath: opts.statePath,
              headed: !!opts.headed,
            },
            { logPrefix: `ab:${id}` }
          )
        : await launchHeaded();

    const { browser, context, child } = launched;

    let activePage =
      context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    const session = {
      id,
      mode: this.mode,
      browser,
      context,
      child,
      pages: [...context.pages()],
      activePage,
      dead: false,
      deathReason: null,
      createdAt: Date.now(),
    };

    if (!session.pages.includes(activePage)) {
      session.pages.push(activePage);
    }

    context.on("page", (newPage) => {
      session.pages.push(newPage);
      session.activePage = newPage;
      console.log(`[session:${id}] switched to new tab: ${newPage.url()}`);
    });

    browser.on("disconnected", () => {
      this._markDead(session, "browser disconnected");
    });
    if (child) {
      child.on("exit", (code, signal) => {
        this._markDead(
          session,
          `agent-browser child exited (code=${code}, signal=${signal})`
        );
      });
    }

    if (opts.headers) {
      await setExtraHTTPHeaders(context, opts.headers);
    }
    if (opts.cookies) {
      await addCookies(context, opts.cookies);
    }
    if (opts.storageState) {
      await applyStorageState(context, activePage, opts.storageState);
    }

    if (opts.loginUrl) {
      await activePage.goto(opts.loginUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    }

    this.sessions.set(id, session);
    return session;
  }

  async ensureDefault() {
    if (this.sessions.has(DEFAULT_SESSION_ID)) return this.get(DEFAULT_SESSION_ID);
    if (this.mode === "headless") {
      // Don't auto-create headless default sessions: callers must POST
      // /session explicitly so they can pass credentials.  Throwing here
      // produces a clearer error than the generic "Unknown sessionId".
      throw new Error(
        "No default session in headless mode. POST /session first to create one."
      );
    }
    return await this.create(DEFAULT_SESSION_ID);
  }

  resolveId(input) {
    return input || DEFAULT_SESSION_ID;
  }

  async destroy(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    await this._teardown(session);
    return true;
  }

  async destroyAll() {
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(sessions.map((s) => this._teardown(s)));
  }

  _markDead(session, reason) {
    if (session.dead) return;
    session.dead = true;
    session.deathReason = reason;
    console.warn(`[session:${session.id}] dead — ${reason}`);
  }

  async _teardown(session) {
    try {
      if (session.browser) await session.browser.close();
    } catch {}
    if (session.child) {
      try {
        session.child.kill("SIGTERM");
      } catch {}
      // SIGKILL fallback if it doesn't exit within 2s
      const child = session.child;
      setTimeout(() => {
        if (!child.killed && child.exitCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      }, 2000).unref();
    }
  }
}

function newSessionId() {
  return `s_${crypto.randomBytes(6).toString("hex")}`;
}

module.exports = { SessionManager, DEFAULT_SESSION_ID, newSessionId };
