/**
 * Milestone screenshot capture: launches Chrome for Testing (WebGPU-capable),
 * loads the dev server, waits for the demo to be ready, and captures a
 * 2560×1440 frame. Also relays console errors.
 *
 * Usage: node tools/screenshot.mjs <name> [urlQuery] [settleMs]
 *   e.g. node tools/screenshot.mjs m1-foundation "state=3" 3000
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

const name = process.argv[2] ?? 'shot';
const query = process.argv[3] ?? '';
const settleMs = parseInt(process.argv[4] ?? '2500', 10);

const exe = `${homedir()}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: [
    '--headless=new',
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    '--use-angle=metal',
    '--enable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
  ],
});

const page = await browser.newPage({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') {
    const loc = msg.location();
    errors.push(`[${msg.type()}] ${msg.text()}${loc && loc.url ? ` (${loc.url})` : ''}`);
  }
});
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
page.on('requestfailed', (req) => errors.push(`[reqfail] ${req.url()} ${req.failure()?.errorText ?? ''}`));
page.on('response', (res) => { if (res.status() >= 400) errors.push(`[http${res.status()}] ${res.url()}`); });

const url = `http://localhost:5174/${query ? '?' + query : ''}`;
await page.goto(url, { waitUntil: 'load', timeout: 20000 });

try {
  await page.waitForFunction(() => window.__NIGHTLOOP__ && window.__NIGHTLOOP__.ready, null, { timeout: 30000 });
} catch {
  console.error('TIMEOUT waiting for __NIGHTLOOP__.ready — capturing anyway');
}

// Optional in-page eval for debugging: EVAL='<js expression>' (awaited, logged)
if (process.env.EVAL) {
  try {
    const r = await page.evaluate(async (code) => {
      const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
      const fn = new AsyncFn('NL', 'BABYLON', `return (${code})`);
      return JSON.stringify(await fn(window.__NIGHTLOOP__, window.BABYLON), null, 1)?.slice(0, 4000);
    }, process.env.EVAL);
    console.log('EVAL →', r);
  } catch (e) {
    console.log('EVAL error:', e.message);
  }
}

// Optional scripted drive: name contains "drive" → hold W and steer for a bit, overlay open.
if (process.env.DRIVE) {
  await page.keyboard.press('Backquote'); // overlay
  await page.keyboard.down('w');
  await page.waitForTimeout(2200);
  await page.keyboard.down('a');
  await page.waitForTimeout(900);
  await page.keyboard.up('a');
  await page.waitForTimeout(600);
}
await page.waitForTimeout(settleMs);

mkdirSync('shots', { recursive: true });
const path = `shots/${name}.png`;
await page.screenshot({ path });
console.log(`saved ${path}`);
if (errors.length) {
  console.log('--- console output ---');
  for (const e of errors.slice(0, 40)) console.log(e);
}
await browser.close();
