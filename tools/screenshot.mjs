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
    '--autoplay-policy=no-user-gesture-required',
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

// Optional scripted drive: hold W and steer for a bit (overlay open unless NOUI).
if (process.env.DRIVE) {
  if (!process.env.NOUI) await page.keyboard.press('Backquote');
  await page.keyboard.down('w');
  if (process.env.DRIVE === 'straight') {
    await page.waitForTimeout(parseInt(process.env.DRIVE_MS ?? '2600', 10));
  } else if (process.env.DRIVE === 'drift') {
    await page.waitForTimeout(parseInt(process.env.RUNUP_MS ?? '2400', 10));
    await page.keyboard.down('Shift');
    await page.keyboard.down('a');
    await page.waitForTimeout(parseInt(process.env.DRIFT_MS ?? '1900', 10));
    if (process.env.DRIFT_END) {
      await page.keyboard.up('a');
      await page.keyboard.up('Shift');
      await page.keyboard.up('w');
      await page.waitForTimeout(700);
    }
  } else {
    await page.waitForTimeout(2200);
    await page.keyboard.down('a');
    await page.waitForTimeout(900);
    await page.keyboard.up('a');
    await page.waitForTimeout(600);
  }
  await page.keyboard.up('w');
}

// Optional post-drive eval (e.g. turn around to look at the tracks)
if (process.env.POST_EVAL) {
  try {
    const r = await page.evaluate(async (code) => {
      const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
      const fn = new AsyncFn('NL', 'BABYLON', `return (${code})`);
      return JSON.stringify(await fn(window.__NIGHTLOOP__, window.BABYLON))?.slice(0, 2000);
    }, process.env.POST_EVAL);
    console.log('POST_EVAL →', r);
  } catch (e) {
    console.log('POST_EVAL error:', e.message);
  }
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
