/* global document */
// Captures screenshots of the main screens with seeded data: node scripts/ui-screens.mjs <outDir>
import { chromium } from 'playwright-core';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { startHarness, openApp } from '../test/support/ui-harness.mjs';

const out = path.resolve(process.argv[2] || 'screens');
await mkdir(out, { recursive: true });
const harness = await startHarness();
const browser = await chromium.launch();
const shots = JSON.parse(process.argv[3] || '[]');
for (const shot of shots.length ? shots : [{ name: 'dashboard', view: 'dashboard' }]) {
  const { page, context, errors } = await openApp(browser, harness.base, { viewport: shot.viewport || { width: 1440, height: 900 }, colorScheme: shot.scheme || 'light', user: shot.user || 'owner' });
  await page.waitForTimeout(700);
  if (shot.view) await page.evaluate(view => document.querySelector(`[data-view="${view}"]`)?.click(), shot.view);
  if (shot.click) for (const selector of [].concat(shot.click)) { await page.click(selector); await page.waitForTimeout(500); }
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, `${shot.name}.png`), fullPage: Boolean(shot.full) });
  if (errors.length) console.log(shot.name, 'page errors:', errors);
  await context.close();
}
await browser.close();
await harness.close();
console.log('saved to', out);
