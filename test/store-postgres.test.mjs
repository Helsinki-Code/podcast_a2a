import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createNeonShim } from './support/pglite-neon.mjs';

process.env.DATABASE_URL = 'postgres://test';
const shim = createNeonShim();
mock.module('@neondatabase/serverless', { namedExports: { neon: shim.neon } });
const store = await import('../lib/store.mjs');
await store.initStore();

test('episode events are stored as rows and read incrementally', async () => {
  const item = { id: store.uid(), ownerId: 'owner-a', status: 'draft', turns: [], events: [], settings: {}, outline: { subject: 'x' } };
  await store.addEpisode(item);
  const first = await store.appendEpisodeEvent(item.id, { id: 'a', type: 'status', status: 'running' });
  const second = await store.appendEpisodeEvent(item.id, { id: 'b', type: 'speech', role: 'host', text: 'Hi', audio: '/api/audio/1111' }, { id: 't1', role: 'host', text: 'Hi' });
  await store.appendEpisodeEvent(item.id, { id: 'c', type: 'tool_end', role: 'guest', tool: 'browser', screen: { type: 'browser', title: 'App', content: 'x'.repeat(9000) } });
  assert.ok(second.seq > first.seq);
  const state = await store.episodeState(item.id);
  assert.equal(state.events, undefined);
  assert.equal(state.turns.length, 1);
  assert.equal(state.guestDemoDone, true);
  assert.equal(state.lastScreen.content.length, 4000);
  const after = await store.episodeEventsAfter(item.id, first.seq);
  assert.deepEqual(after.map(event => event.id), ['b', 'c']);
  const full = await store.episode(item.id);
  assert.deepEqual(full.events.map(event => event.id), ['a', 'b', 'c']);
  await store.acknowledgeEpisodeSpeech(item.id, 'b');
  assert.equal((await store.episode(item.id)).events[1].acknowledged, true);
  assert.equal(await store.assetOwnedBy('owner-a', '/api/audio/1111'), true);
  assert.equal(await store.assetOwnedBy('owner-b', '/api/audio/1111'), false);
});

test('saving an episode never writes the event log back into the document', async () => {
  const item = { id: store.uid(), ownerId: 'owner-a', status: 'draft', turns: [], events: [], settings: {}, outline: { subject: 'x' } };
  await store.addEpisode(item);
  await store.appendEpisodeEvent(item.id, { id: 'a', type: 'notice', message: 'hi' });
  const loaded = await store.episode(item.id);
  loaded.video = '/assets/v.webm';
  await store.save(loaded);
  const rows = await shim.db.query('SELECT document FROM podcast_episodes WHERE id = $1', [item.id]);
  assert.equal(rows.rows[0].document.events, undefined);
  assert.equal((await store.episode(item.id)).events.length, 1);
});

test('legacy episodes with an embedded event log are migrated once', async () => {
  const id = store.uid();
  const legacy = { id, ownerId: 'owner-a', status: 'complete', turns: [], settings: {}, outline: { subject: 'x' }, events: [{ id: 'l1', type: 'status' }, { id: 'l2', type: 'speech', audio: '/api/audio/2222' }] };
  await shim.db.query('INSERT INTO podcast_episodes (id, document) VALUES ($1, $2::jsonb)', [id, JSON.stringify(legacy)]);
  const [a, b] = await Promise.all([store.episode(id), store.episode(id)]);
  assert.deepEqual(a.events.map(event => event.id), ['l1', 'l2']);
  assert.deepEqual(b.events.map(event => event.id), ['l1', 'l2']);
  const count = await shim.db.query('SELECT count(*)::int AS n FROM podcast_episode_events WHERE episode_id = $1', [id]);
  assert.equal(count.rows[0].n, 2);
  const listed = await store.listEpisodes('owner-a');
  assert.ok(listed.every(entry => entry.events === undefined));
});
