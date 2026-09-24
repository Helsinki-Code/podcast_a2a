import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const originalCwd = process.cwd();
const temp = await mkdtemp(path.join(os.tmpdir(), 'live-podcast-test-'));
process.chdir(temp);
const store = await import('../lib/store.mjs');
const providers = await import('../lib/providers.mjs');
const { runEpisode } = await import('../lib/engine.mjs');
const { retrieve, buildIndex } = await import('../lib/rag.mjs');
const { startSpeech, openLiveAudio } = await import('../lib/audio.mjs');
const { ownContext } = await import('../lib/conversation.mjs');
await store.initStore();

test('retrieval returns only relevant source chunks', () => {
  const files = [{ name: 'solar.txt', text: 'Photovoltaic panels turn sunlight into electricity. Solar cells are installed on roofs.' }, { name: 'baking.txt', text: 'Bread needs flour and water.' }];
  const index = buildIndex(files);
  assert.equal(retrieve(index, 'How do solar panels work?')[0].source, 'solar.txt');
});

test('guest context requires a real browser demo without exposing login secrets', () => {
  const episode = { outline: { subject: 'Platform overview', angle: 'private', points: '' }, turns: [], events: [], settings: { hostTools: false, requireGuestDemo: true, demo: { url: 'https://example.com/app', brief: 'Show the dashboard.', authRequired: true } } };
  const messages = ownContext(episode, 'guest', { systemPrompt: 'Explain clearly.', knowledge: [] }, { type: 'browser', title: 'Dashboard', content: 'Overview' }, 'turn');
  const text = JSON.stringify(messages);
  assert.match(text, /requires a real live computer demonstration/);
  assert.match(text, /https:\/\/example\.com\/app/);
  assert.doesNotMatch(text, /hunter2|secret@example\.com/i);
});

test('paid credits are granted once, debited once per job, and isolated by owner', async () => {
  const userId = 'user_test_credit_owner';
  await store.account(userId, 'owner@example.com');
  await store.updateSubscription(userId, { plan: 'starter', subscriptionStatus: 'active', stripeSubscriptionId: 'sub_test', stripePriceId: 'price_test' });
  assert.equal(await store.grantCredits(userId, 100, 'subscription_cycle', 'in_test', 'invoice:in_test'), true);
  assert.equal(await store.grantCredits(userId, 100, 'subscription_cycle', 'in_test', 'invoice:in_test'), false);
  assert.equal(await store.reserveCredits(userId, 20, 'podcast', 'episode_test'), true);
  assert.equal(await store.reserveCredits(userId, 20, 'podcast', 'episode_test'), true);
  assert.equal((await store.account(userId)).credits, 80);
  await store.addPersona({ id: store.uid(), ownerId: userId, name: 'Owned', systemPrompt: 'Test', image: '/assets/owned.png' });
  await store.addPersona({ id: store.uid(), ownerId: 'another_user', name: 'Hidden', systemPrompt: 'Test' });
  assert.deepEqual((await store.listPersonas(userId)).map(item => item.name), ['Owned']);
  assert.equal(await store.assetOwnedBy(userId, 'owned.png'), true);
  assert.equal(await store.assetOwnedBy('another_user', 'owned.png'), false);
});

test('speech chunks reach playback before the archive is complete', async () => {
  const stream = startSpeech({ async synthesize() { return (async function* () { yield Buffer.from('first'); await new Promise(resolve => setTimeout(resolve, 10)); yield Buffer.from('second'); })(); } }, 'hello', 'test');
  const req = new EventEmitter();
  const res = { chunks: [], ended: false, writeHead(status) { this.status = status; }, write(chunk) { this.chunks.push(Buffer.from(chunk)); }, end() { this.ended = true; }, destroy(error) { throw error; } };
  assert.equal(openLiveAudio(stream.id, req, res), true);
  await stream.done;
  assert.equal(res.status, 200);
  assert.equal(Buffer.concat(res.chunks).toString(), 'firstsecond');
  assert.equal(res.ended, true);
  assert.equal((await readFile(path.join(temp, 'data/assets', `${stream.id}.mp3`))).toString(), 'firstsecond');
});

test('episode alternates, keeps private outline out of guest context, and stores live diagram', async () => {
  const seen = [];
  const screens = [];
  providers.registerModel('test-model', {
    async generate(messages) {
      const system = messages[0].content;
      seen.push(system);
      screens.push(messages[1].content);
      if (system.includes('You are the host')) {
        const turnNumber = seen.filter(x => x.includes('You are the host')).length;
        return turnNumber === 1 ? { segments: [
          { type: 'speak', text: 'Can you show us the photovoltaic flow?' },
          { type: 'act', tool: 'diagram', input: { title: 'Solar flow', nodes: [{ id: 'a', label: 'Sun' }, { id: 'b', label: 'Panel' }], edges: [{ from: 'a', to: 'b' }] } },
          { type: 'speak', text: 'This was written before the diagram appeared and must be discarded.' }
        ], finish: false } : turnNumber === 2 ? { segments: [{ type: 'speak', text: 'The diagram now shows sunlight flowing to a panel.' }], finish: false } : { segments: [{ type: 'speak', text: 'Thanks. That is a good place to finish.' }], finish: true };
      }
      assert.ok(system.includes('You are the guest'));
      assert.ok(!system.includes('SECRET HOST ANGLE'));
      return { segments: [{ type: 'speak', text: 'Yes. A panel converts sunlight into electrical current.' }], finish: false };
    }
  });
  providers.registerSpeech('test-speech', { async synthesize(text) { return Buffer.from(`fake mp3 ${text}`); } });
  const host = await store.addPersona({ id: store.uid(), name: 'Host', systemPrompt: 'Interview clearly.', modelProvider: 'test-model', speechProvider: 'test-speech', voice: 'alloy', knowledge: [] });
  const guest = await store.addPersona({ id: store.uid(), name: 'Guest', systemPrompt: 'Explain solar energy.', modelProvider: 'test-model', speechProvider: 'test-speech', voice: 'coral', knowledge: [{ name: 'solar.txt', text: 'Photovoltaic panels turn sunlight into electricity.' }] });
  const episode = await store.addEpisode({ id: store.uid(), status: 'draft', hostId: host.id, guestId: guest.id, personas: { host: structuredClone(host), guest: structuredClone(guest) }, outline: { subject: 'Solar energy', angle: 'SECRET HOST ANGLE', points: 'Roofs' }, settings: { interjections: false, hostTools: true, maxMinutes: 1 }, turns: [], events: [] });
  await store.updatePersona(host.id, { systemPrompt: 'A later edit that must not change this episode.' });
  await runEpisode(episode, () => {}, async () => {});
  assert.equal(episode.status, 'complete');
  const roles = episode.turns.map(x => x.role);
  assert.deepEqual(roles.filter((role, i) => i === 0 || role !== roles[i - 1]), ['host','guest','host']);
  assert.ok(episode.events.some(x => x.type === 'tool_end' && x.screen.type === 'diagram'));
  assert.ok(!episode.turns.some(x => x.text.includes('must be discarded')));
  assert.ok(screens.some(x => x.includes('Solar flow')));
  assert.ok(seen.some(x => x.includes('SECRET HOST ANGLE')));
  assert.ok(seen.some(x => x.includes('Interview clearly.')));
  assert.ok(!seen.some(x => x.includes('A later edit')));
  const saved = JSON.parse(await readFile(path.join(temp, 'data/studio.json'), 'utf8'));
  assert.equal(saved.episodes[0].status, 'complete');
  assert.ok(seen.some(x => x.includes('SECRET HOST ANGLE')));
});

test.after(() => process.chdir(originalCwd));
