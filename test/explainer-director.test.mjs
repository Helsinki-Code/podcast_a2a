import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Runs the real explainer workflow loop with the model and sandbox steps replaced, to check that a
// director that keeps choosing invalid targets still yields a finished video instead of a failure.
const real = await import('../workflows/explainer-steps.mjs');
const { loopView } = await import('../lib/conversation-loop.mjs');

const content = [
  '- heading "Dashboard" [ref=e1]',
  '- link "Pricing" [ref=e2]',
  '- button "Delete account" [ref=e3]',
  '- link "Reports" [ref=e4]',
  '- textbox "Search" [ref=e5]'
].join('\n');

test('fallback scene action picks an unused safe link, then scrolls', () => {
  const screen = { title: 'Dashboard', content };
  assert.deepEqual(real.fallbackSceneAction(screen, []), { type: 'click', selector: '@e2' });
  assert.deepEqual(real.fallbackSceneAction(screen, ['click:@e2:']), { type: 'click', selector: '@e4' });
  const scroll = real.fallbackSceneAction(screen, ['click:@e2:', 'click:@e4:']);
  assert.equal(scroll.type, 'scroll');
  assert.equal(scroll.direction, 'down');
  assert.equal(real.fallbackSceneAction(screen, ['click:@e2:', 'click:@e4:', 'scroll:down', 'scroll:down', 'scroll:down']).direction, 'up');
});

test('the workflow snapshot leaves out persona knowledge, embeddings, and the event log', () => {
  const view = loopView({
    id: 'e1', status: 'running', settings: { maxMinutes: 10 }, outline: { subject: 'CRM', points: ['a'] },
    personas: { host: { id: 'p1', name: 'Ada', systemPrompt: 'x'.repeat(5000), knowledge: [{ name: 'k.txt', text: 'y'.repeat(100000) }], knowledgeIndex: [{ vector: new Array(256).fill(0.1) }] } },
    turns: [{ id: 't1', role: 'host', text: 'Hi', sources: ['k.txt'] }], events: [{ type: 'speech' }], memory: { summary: 'z'.repeat(2000), throughTurn: 3 }
  });
  assert.deepEqual(view.personas, { host: { id: 'p1', name: 'Ada' } });
  assert.deepEqual(view.turns, [{ role: 'host', text: 'Hi' }]);
  assert.deepEqual(view.memory, { throughTurn: 3 });
  assert.equal('events' in view, false);
  assert.ok(JSON.stringify(view).length < 500);
});

test('an explainer whose director keeps choosing invalid targets still finishes', async () => {
  const calls = { finished: null, failed: null, rendered: [] };
  mock.module('../workflows/explainer-steps.mjs', {
    namedExports: {
      ...real,
      beginExplainer: async () => ({ title: 'Dashboard', content, visualHash: 'start' }),
      explainerSceneBudget: async () => 4,
      explainerRequirements: async () => ['type'],
      planScene: async () => ({ narration: 'Here is the next part of the product.', action: { type: 'click', selector: 'button.does-not-exist' } }),
      renderScene: async (id, index, narration, action) => {
        calls.rendered.push(action);
        return { screen: { title: `Page ${index}`, content, visualHash: `h${index}` }, duration: 3, captionDuration: 3, video: `/tmp/${index}.mp4`, audio: `/tmp/${index}.m4a`, sceneAsset: `/assets/${index}.mp4`, usedScreenshotFallback: false };
      },
      finishExplainer: async (id, timeline) => { calls.finished = timeline; },
      failExplainer: async (id, message) => { calls.failed = message; }
    }
  });
  const { explainerWorkflow } = await import('../workflows/explainer.mjs');
  await explainerWorkflow('x1');
  assert.equal(calls.failed, null);
  assert.ok(calls.finished?.length >= 2);
  assert.deepEqual(calls.rendered.slice(0, 2), [{ type: 'click', selector: '@e2' }, { type: 'click', selector: '@e4' }]);
  assert.ok(!calls.rendered.some(action => action.selector === '@e3'), 'never clicks a destructive control');
});
