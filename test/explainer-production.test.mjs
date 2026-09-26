import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlan, sceneBudgetFor, buildCaptions } from '../workflows/explainer-steps.mjs';
import { focusFilters, DISMISS_OVERLAYS_SCRIPT } from '../lib/explainer-effects.mjs';
import { ffmetadata, normalizeChapters, youtubeChapterText, titleFromText } from '../lib/chapters.mjs';

test('scene plans are cleaned, capped, and drive the scene budget once approved', () => {
  const scenes = normalizePlan({ scenes: [{ title: ' Open   dashboard ', goal: 'Click Dashboard', narration: 'We start on the dashboard.' }, { title: 'Empty', goal: '', narration: '' }, { title: 'Filter', goal: 'Type a region', narration: 'Now we filter by region.' }] }, 5);
  assert.deepEqual(scenes.map(scene => scene.title), ['Open dashboard', 'Filter']);
  assert.equal(sceneBudgetFor({ brief: 'Show the dashboard.', plan: { approved: true, scenes } }), 2);
  assert.equal(sceneBudgetFor({ brief: 'Show the dashboard.', plan: { approved: false, scenes } }), 5);
  assert.equal(normalizePlan({ scenes: new Array(30).fill({ title: 't', goal: 'g', narration: 'n' }) }, 8).length, 8);
});

test('click emphasis zooms toward the target and highlights it around the click', () => {
  const filters = focusFilters({ x: 800, y: 500, width: 200, height: 40 }, 1.8, {});
  assert.equal(filters.length, 2);
  assert.match(filters[0], /drawbox=x=790:y=490:w=220:h=60.*between\(t,1\.35,2\.70\)/);
  assert.match(filters[1], /zoompan=z='1\+0\.32\*min\(1,max\(0,\(it-0\.90\)/);
  assert.match(filters[1], /900-iw\/zoom\/2/);
  assert.equal(focusFilters({ x: 10, y: 10, width: 0, height: 0 }, 1, {}).length, 1, 'coordinate-only targets zoom without a box');
  assert.equal(focusFilters(null, 1).length, 0);
  assert.equal(focusFilters({ x: 1, y: 1, width: 50, height: 50 }, 1, { zoom: false, highlight: false }).length, 0);
  assert.match(DISMISS_OVERLAYS_SCRIPT, /no,\? thanks/);
  assert.match(DISMISS_OVERLAYS_SCRIPT, /subscribe\|sign \?up/);
});

test('chapters satisfy YouTube rules and embed as MP4 chapter metadata', () => {
  const chapters = normalizeChapters([{ start: 0, title: 'Intro' }, { start: 4, title: 'Dashboard' }, { start: 20, title: 'Filters' }, { start: 41, title: 'Export' }, { start: 58, title: 'Tail' }], 60);
  assert.deepEqual(chapters, [{ start: 0, title: 'Dashboard' }, { start: 20, title: 'Filters' }, { start: 41, title: 'Export' }]);
  assert.equal(youtubeChapterText(chapters), '0:00 Dashboard\n0:20 Filters\n0:41 Export');
  assert.equal(youtubeChapterText(chapters.slice(0, 2)), '');
  const meta = ffmetadata(chapters, 60, { title: 'Tour; part=1' });
  assert.ok(meta.startsWith(';FFMETADATA1\ntitle=Tour\\; part\\=1\n[CHAPTER]'), meta);
  assert.match(meta, /START=41000\nEND=60000\ntitle=Export/);
  assert.equal(titleFromText('Open the reports page to compare quarterly revenue trends.', 4), 'Open the reports page…');
});

test('explainer captions can start after an intro card', () => {
  const srt = buildCaptions([{ text: 'Hello there', duration: 2, captionDuration: 2 }], { offset: 3.5 });
  assert.match(srt, /^1\n00:00:03,500 --> 00:00:05,500/);
});
