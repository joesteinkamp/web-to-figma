#!/usr/bin/env node
// Builds a clean Chrome Web Store package from chrome-extension/.
// Copies only files referenced by manifest.json (and popup.html), validates
// that every reference exists, and produces a versioned .zip in dist/.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../..');
const srcDir = join(repoRoot, 'chrome-extension');
const distDir = join(repoRoot, 'dist');
const outDir = join(distDir, 'chrome-extension');

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function collectFromManifest(manifest) {
  const files = new Set(['manifest.json']);

  if (manifest.background?.service_worker) {
    files.add(manifest.background.service_worker);
  }
  if (manifest.action?.default_popup) {
    files.add(manifest.action.default_popup);
  }
  for (const iconPath of Object.values(manifest.action?.default_icon ?? {})) {
    files.add(iconPath);
  }
  for (const iconPath of Object.values(manifest.icons ?? {})) {
    files.add(iconPath);
  }
  for (const cs of manifest.content_scripts ?? []) {
    for (const f of cs.js ?? []) files.add(f);
    for (const f of cs.css ?? []) files.add(f);
  }
  for (const res of manifest.web_accessible_resources ?? []) {
    for (const f of res.resources ?? []) files.add(f);
  }

  return files;
}

function collectFromHtml(htmlPath, htmlContent) {
  const files = new Set();
  const htmlDir = dirname(htmlPath);

  // <link rel="stylesheet" href="..."> and <script src="...">
  const patterns = [
    /<link[^>]+href=["']([^"']+)["']/gi,
    /<script[^>]+src=["']([^"']+)["']/gi,
  ];
  for (const re of patterns) {
    for (const match of htmlContent.matchAll(re)) {
      const ref = match[1];
      if (/^(https?:|data:|\/\/|#)/.test(ref)) continue;
      const abs = resolve(htmlDir, ref);
      files.add(relative(srcDir, abs));
    }
  }
  return files;
}

const manifestPath = join(srcDir, 'manifest.json');
if (!existsSync(manifestPath)) fail(`manifest.json not found at ${manifestPath}`);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const version = manifest.version;
if (!version) fail('manifest.json is missing "version"');

const included = collectFromManifest(manifest);

// Parse every HTML file referenced by the manifest for additional assets.
for (const f of [...included]) {
  if (!f.endsWith('.html')) continue;
  const htmlPath = join(srcDir, f);
  if (!existsSync(htmlPath)) continue;
  const extra = collectFromHtml(htmlPath, readFileSync(htmlPath, 'utf8'));
  for (const e of extra) included.add(e);
}

// Validate every referenced file exists.
const missing = [...included].filter((f) => !existsSync(join(srcDir, f)));
if (missing.length) {
  fail(`manifest references files that do not exist:\n  - ${missing.join('\n  - ')}`);
}

// Reject any junk that slipped in via the HTML parser.
const junkPatterns = [/\.DS_Store$/i, /\.map$/i, /~$/, /\.swp$/i];
const junk = [...included].filter((f) => junkPatterns.some((re) => re.test(f)));
if (junk.length) {
  fail(`refusing to ship junk files:\n  - ${junk.join('\n  - ')}`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const sortedFiles = [...included].sort();
for (const f of sortedFiles) {
  const from = join(srcDir, f);
  const to = join(outDir, f);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

const zipName = `web-to-figma-v${version}.zip`;
const zipPath = join(distDir, zipName);
rmSync(zipPath, { force: true });
execFileSync('zip', ['-rq', zipName, 'chrome-extension'], { cwd: distDir, stdio: 'inherit' });

console.log(`✓ Built ${outDir}`);
for (const f of sortedFiles) console.log(`    ${f}`);
console.log(`✓ Packaged ${zipPath}`);
