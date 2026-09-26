/* global document, location */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openApp } from './support/ui-harness.mjs';

let chromium = null;
try { ({ chromium } = await import('playwright-core')); } catch {}
let browser = null;
try { browser = chromium && await chromium.launch(); } catch {}
const skip = !browser && 'Chromium is not available';
const harness = skip ? null : await startHarness();
test.after(async () => { await browser?.close(); await harness?.close(); });

test('workspace loads every view without script errors', { skip }, async () => {
  const { page, errors, context } = await openApp(browser, harness.base);
  await page.waitForSelector('#statTiles .stat-tile');
  for (const view of ['library', 'personas', 'billing', 'team', 'settings', 'dashboard']) {
    await page.click(`.nav[data-view=${view}]`);
    await page.waitForFunction(v => !document.querySelector(`#view-${v}`).classList.contains('hidden'), view);
    await page.waitForTimeout(250);
  }
  assert.deepEqual(errors, []);
  await context.close();
});

test('library search, type tabs, rename, and delete', { skip }, async () => {
  const { page, context } = await openApp(browser, harness.base, { path: '/#/library' });
  await page.waitForSelector('.library-card');
  const total = await page.locator('.library-card').count();
  await page.click('[data-library-type=explainer]');
  assert.equal(await page.locator('.library-card[data-kind=podcast]').count(), 0);
  await page.click('[data-library-type=all]');
  await page.fill('#librarySearch', 'pricing');
  assert.equal(await page.locator('.library-card').count(), 1);
  const card = page.locator('.library-card').first();
  await card.locator('summary[aria-label^="More actions"]').click();
  await card.locator('[data-action=rename]').click();
  await page.fill('#confirmDialog input', 'Pricing tests, renamed');
  await page.click('#confirmDialog [data-confirm]');
  await page.fill('#librarySearch', 'renamed');
  await page.waitForSelector('.library-card h3:has-text("Pricing tests, renamed")');
  await page.locator('.library-card').first().locator('summary[aria-label^="More actions"]').click();
  await page.locator('.library-card').first().locator('[data-action=delete]').click();
  await page.click('#confirmDialog [data-confirm]');
  await page.fill('#librarySearch', '');
  await page.waitForFunction(count => document.querySelectorAll('.library-card').length === count - 1, total);
  await context.close();
});

test('the wizard validates each step and creates an episode that opens in the studio', { skip }, async () => {
  const { page, context, errors } = await openApp(browser, harness.base);
  await page.waitForSelector('#statTiles .stat-tile');
  await page.click('.top-actions [data-new=podcast]');
  await page.click('#wizardNext');
  await page.click('#wizardNext');
  assert.ok(await page.locator('.wizard-step[data-step="1"]:not(.hidden)').count(), 'an empty subject keeps the wizard on the topic step');
  await page.fill('#episodeForm [name=subject]', 'Wizard made episode');
  await page.click('#wizardNext');
  await page.uncheck('#episodeForm [name=requireGuestDemo]');
  await page.click('#wizardNext');
  await page.click('#wizardNext');
  assert.match(await page.textContent('#wizardSummary'), /Wizard made episode/);
  await page.click('#wizardCreate');
  await page.waitForFunction(() => location.hash.startsWith('#/studio/'));
  await page.waitForSelector('#studioTitle:has-text("Wizard made episode")');
  assert.ok(await page.isVisible('#startEpisode'));
  assert.deepEqual(errors, []);
  await context.close();
});

test('viewers see the workspace read-only', { skip }, async () => {
  const invite = await harness.store.createTeamInvite((await harness.store.ensureTeam('owner')).id, 'viewer1@example.com', 'viewer');
  await harness.store.addTeamMember(invite.teamId, 'viewer1', 'viewer1@example.com', 'viewer');
  const { page, context } = await openApp(browser, harness.base, { user: 'viewer1', path: '/#/library' });
  await page.waitForSelector('.library-card');
  assert.equal(await page.isVisible('.top-actions [data-new=podcast]'), false);
  assert.match(await page.textContent('#roleBadge'), /viewer/);
  await page.locator('.library-card').first().locator('summary[aria-label^="More actions"]').click().catch(() => {});
  assert.equal(await page.locator('.library-card [data-action=delete]').count(), 0);
  await context.close();
});

test('every visible control has an accessible name', { skip }, async () => {
  const { page, context } = await openApp(browser, harness.base, { path: '/#/library' });
  await page.waitForSelector('.library-card');
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea')]
    .filter(element => element.offsetParent !== null)
    .filter(element => {
      const label = element.getAttribute('aria-label') || element.textContent.trim() || element.getAttribute('title') || element.getAttribute('placeholder') || (element.id && document.querySelector(`label[for="${element.id}"]`)) || element.closest('label');
      return !label;
    }).map(element => element.outerHTML.slice(0, 120)));
  assert.deepEqual(unnamed, []);
  await context.close();
});
