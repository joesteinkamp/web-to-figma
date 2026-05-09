// CSP bypass via raw CDP.
//
// Playwright's `bypassCSP: true` newContext option only works when the
// browser was launched via chromium.launch() — for connectOverCDP browsers
// (e.g. agent-browser) it's silently a no-op.  We need CSP bypass so Figma's
// capture script can run on any site, so we enable it directly via the
// Network.setBypassCSP CDP command.
//
// CSP is parsed when the page document is created, so this MUST be enabled
// BEFORE the first page.goto().  Use installBypassCSPForContext() to wire
// it to every existing page AND every future page (popups, new tabs).

async function enableBypassCSP(page) {
  try {
    const session = await page.context().newCDPSession(page);
    await session.send("Network.enable");
    await session.send("Network.setBypassCSP", { enabled: true });
  } catch (err) {
    console.warn(`  ⚠ Failed to enable CSP bypass on page: ${err.message}`);
  }
}

async function installBypassCSPForContext(context) {
  for (const page of context.pages()) {
    await enableBypassCSP(page);
  }
  context.on("page", (page) => {
    enableBypassCSP(page).catch(() => {});
  });
}

module.exports = { enableBypassCSP, installBypassCSPForContext };
