// Mode-agnostic page capture: flatten iframes into the parent DOM, fetch
// Figma's capture script, inject it, and trigger captureForDesign.  Works
// against any Playwright Page regardless of whether the underlying browser
// was launched locally or connected over CDP (e.g. via agent-browser).

const FIGMA_CAPTURE_SCRIPT_URL =
  "https://mcp.figma.com/mcp/html-to-design/capture.js";

// CSS properties to inline when flattening iframe DOM into the parent page.
// This whitelist covers layout, text, and visual properties that Figma's
// capture script needs to reconstruct editable design nodes.
const INLINE_STYLE_PROPERTIES = [
  // Layout
  "display", "position", "width", "height", "min-width", "min-height",
  "max-width", "max-height", "margin", "padding", "box-sizing", "overflow",
  "top", "right", "bottom", "left", "z-index", "float", "clear",
  "vertical-align",
  // Flex / Grid
  "flex-direction", "flex-wrap", "align-items", "justify-content", "gap",
  "flex-grow", "flex-shrink", "flex-basis", "align-self", "order",
  "grid-template-columns", "grid-template-rows", "grid-column", "grid-row",
  // Text
  "font-family", "font-size", "font-weight", "font-style", "line-height",
  "text-align", "text-decoration", "text-transform", "letter-spacing",
  "white-space", "word-break", "color",
  // Visual
  "background-color", "background-image", "background-size",
  "background-position", "background-repeat", "border", "border-radius",
  "box-shadow", "opacity", "outline", "text-shadow", "transform",
  "visibility",
];

async function flattenIframesIntoPage(targetPage) {
  const iframes = await targetPage.$$("iframe");
  if (iframes.length === 0) return;

  console.log(`Found ${iframes.length} iframe(s) — flattening into parent DOM…`);
  let flattened = 0;
  let screenshotted = 0;

  for (const iframeHandle of iframes) {
    try {
      const box = await iframeHandle.boundingBox();
      if (!box || box.width === 0 || box.height === 0) continue;

      const frame = await iframeHandle.contentFrame();
      if (!frame) {
        await replaceIframeWithScreenshot(targetPage, iframeHandle, box);
        screenshotted++;
        continue;
      }

      await frame
        .waitForLoadState("domcontentloaded", { timeout: 5000 })
        .catch(() => {});

      const extractedHTML = await frame.evaluate((props) => {
        const MAX_DEPTH = 50;

        function inlineStyles(el, depth) {
          if (depth > MAX_DEPTH) return;
          if (el.nodeType !== 1) return;

          const computed = window.getComputedStyle(el);
          for (const prop of props) {
            const value = computed.getPropertyValue(prop);
            if (value) el.style.setProperty(prop, value);
          }

          const base = document.baseURI;
          if (el.tagName === "IMG" && el.getAttribute("src")) {
            try { el.src = new URL(el.getAttribute("src"), base).href; } catch {}
          }
          if (el.tagName === "A" && el.getAttribute("href")) {
            try { el.href = new URL(el.getAttribute("href"), base).href; } catch {}
          }
          const bgImg = computed.getPropertyValue("background-image");
          if (bgImg && bgImg !== "none" && bgImg.includes("url(")) {
            el.style.setProperty("background-image", bgImg);
          }

          for (const child of el.children) {
            inlineStyles(child, depth + 1);
          }
        }

        const body = document.body;
        if (!body) return null;

        inlineStyles(body, 0);
        return body.innerHTML;
      }, INLINE_STYLE_PROPERTIES);

      if (!extractedHTML) {
        await replaceIframeWithScreenshot(targetPage, iframeHandle, box);
        screenshotted++;
        continue;
      }

      await iframeHandle.evaluate(
        (iframe, { html, width, height }) => {
          const container = document.createElement("div");
          container.style.cssText = `all:initial;display:block;width:${width}px;height:${height}px;overflow:hidden;`;
          container.innerHTML = html;
          iframe.parentNode.replaceChild(container, iframe);
        },
        { html: extractedHTML, width: box.width, height: box.height }
      );

      flattened++;
    } catch (err) {
      try {
        const box = await iframeHandle.boundingBox().catch(() => null);
        if (box) {
          await replaceIframeWithScreenshot(targetPage, iframeHandle, box);
          screenshotted++;
        }
      } catch {
        // skip
      }
      console.log(`  ⚠ iframe flatten failed (${err.message}) — used fallback`);
    }
  }

  console.log(`  ✓ ${flattened} flattened via DOM, ${screenshotted} via screenshot`);
}

async function replaceIframeWithScreenshot(targetPage, iframeHandle, box) {
  const buffer = await iframeHandle.screenshot({ type: "png" });
  const base64 = buffer.toString("base64");
  await iframeHandle.evaluate(
    (iframe, { src, width, height }) => {
      const img = document.createElement("img");
      img.src = src;
      img.style.cssText = `display:block;width:${width}px;height:${height}px;`;
      iframe.parentNode.replaceChild(img, iframe);
    },
    { src: `data:image/png;base64,${base64}`, width: box.width, height: box.height }
  );
}

// Fetch Figma's capture script over Node's built-in fetch so it doesn't
// depend on the connected browser's request context (which behaves
// differently between launched and connectOverCDP browsers).
async function fetchCaptureScript() {
  const res = await fetch(FIGMA_CAPTURE_SCRIPT_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch Figma capture script: ${res.status} ${res.statusText}`
    );
  }
  return await res.text();
}

async function captureToFigma(page, { captureId, endpoint }) {
  await flattenIframesIntoPage(page);

  const scriptText = await fetchCaptureScript();

  await page.evaluate((s) => {
    const el = document.createElement("script");
    el.textContent = s;
    document.head.appendChild(el);
  }, scriptText);

  await page.waitForTimeout(1000);

  // captureForDesign may navigate the page on success, which destroys the
  // execution context.  Treat that specific error as a successful submission.
  return await page
    .evaluate(
      ({ captureId, endpoint }) =>
        window.figma.captureForDesign({ captureId, endpoint, selector: "body" }),
      { captureId, endpoint }
    )
    .catch((err) => {
      if (err.message.includes("Execution context was destroyed")) {
        return { success: true, note: "Page navigated after capture submission" };
      }
      throw err;
    });
}

module.exports = {
  flattenIframesIntoPage,
  captureToFigma,
  INLINE_STYLE_PROPERTIES,
};
