// Auth primitives applied to a Playwright BrowserContext after connecting.
//
// agent-browser handles some credential flows itself (vault, --session-name,
// --profile, --headers), but we still need server-side primitives for:
//   - cookies passed through the API (most flexible auth path)
//   - extra HTTP headers per session (bearer tokens, custom auth)
//   - full Playwright storageState restoration (cookies + per-origin
//     localStorage), which Playwright only supports via newContext({storageState})
//     for launched browsers, not for connectOverCDP.

async function setExtraHTTPHeaders(context, headers) {
  if (!headers || Object.keys(headers).length === 0) return;
  await context.setExtraHTTPHeaders(headers);
}

async function addCookies(context, cookies) {
  if (!cookies || cookies.length === 0) return;
  await context.addCookies(cookies);
}

// Restore a Playwright storageState object on a connected browser.
//
// Cookies are easy: addCookies handles them at the context level.  localStorage
// is origin-scoped, so we have to navigate to each origin and seed it via
// page.evaluate.  This mutates the page's URL during setup — callers should
// invoke this BEFORE the user-requested navigation.
async function applyStorageState(context, page, storageState) {
  if (!storageState) return;

  if (storageState.cookies && storageState.cookies.length > 0) {
    await context.addCookies(storageState.cookies);
  }

  if (Array.isArray(storageState.origins)) {
    for (const entry of storageState.origins) {
      if (!entry?.origin) continue;
      try {
        await page.goto(entry.origin, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        await page.evaluate((origin) => {
          for (const item of origin.localStorage || []) {
            try {
              window.localStorage.setItem(item.name, item.value);
            } catch {}
          }
        }, entry);
      } catch (err) {
        console.warn(
          `  ⚠ Failed to seed localStorage for ${entry.origin}: ${err.message}`
        );
      }
    }
  }
}

module.exports = { setExtraHTTPHeaders, addCookies, applyStorageState };
