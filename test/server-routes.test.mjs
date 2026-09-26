import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const temp = await mkdtemp(path.join(os.tmpdir(), 'server-routes-'));
process.chdir(temp);
delete process.env.DATABASE_URL;
mock.module('../lib/auth.mjs', { namedExports: {
  authenticate: async req => (req.headers.authorization || '').startsWith('Bearer ') ? { userId: req.headers.authorization.slice(7) } : null,
  primaryEmail: async () => 'owner@example.com'
} });
const store = await import('../lib/store.mjs');
const { handler } = await import('../server.mjs');
const server = http.createServer(handler);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, route, { user = 'paid', body, raw, type } = {}) => {
  const response = await fetch(base + route, { method, headers: { ...(user ? { Authorization: `Bearer ${user}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(type ? { 'Content-Type': type } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
};

test.before(async () => {
  await store.initStore();
  await store.account('paid');
  await store.updateSubscription('paid', { subscriptionStatus: 'active', plan: 'pro' });
  await store.grantCredits('paid', 300, 'test', 'seed', 'seed-paid');
});
test.after(() => server.close());

test('auth and paywall gate the workspace routes', async () => {
  assert.equal((await call('GET', '/api/personas', { user: null })).status, 401);
  assert.equal((await call('GET', '/api/personas', { user: 'unpaid' })).status, 402);
  assert.equal((await call('GET', '/api/auth/me', { user: 'unpaid' })).status, 200);
  assert.equal((await call('GET', '/api/nothing-here')).status, 404);
  assert.equal((await call('GET', '/health', { user: null })).status, 200);
});

test('personas, a panel episode, and the incremental event feed work through the split routes', async () => {
  const ids = [];
  for (const name of ['Hana', 'Gus', 'Cole']) {
    const created = await call('POST', '/api/personas', { body: { name, systemPrompt: `${name} speaks clearly.`, voice: 'coral', voiceStyle: 'warm' } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.voiceStyle, 'warm');
    ids.push(created.data.id);
  }
  const episode = await call('POST', '/api/episodes', { body: { hostId: ids[0], guestId: ids[1], cohostId: ids[2], outline: { subject: 'Testing' }, settings: { targetMinutes: 8, maxInterruptions: 2, playbackMode: 'background', music: { bed: true, volume: 0.5 } } } });
  assert.equal(episode.status, 201, JSON.stringify(episode.data));
  assert.deepEqual(Object.keys(episode.data.personas).sort(), ['cohost', 'guest', 'host']);
  assert.equal(new Set(Object.values(episode.data.personas).map(p => p.voice)).size, 3, 'no two cast members share a voice');
  assert.equal(episode.data.settings.music.volume, 0.3, 'music volume is clamped');
  assert.equal(episode.data.settings.targetMinutes, 8);
  assert.equal((await call('POST', '/api/episodes', { body: { hostId: ids[0], guestId: ids[0], outline: { subject: 'x' } } })).status, 400);
  await store.appendEpisodeEvent(episode.data.id, { id: 'e1', type: 'status', status: 'running' });
  await store.appendEpisodeEvent(episode.data.id, { id: 'e2', type: 'notice', message: 'hi' });
  const all = await call('GET', `/api/episodes/${episode.data.id}/events?format=json`);
  assert.deepEqual(all.data.events.map(event => event.id), ['e1', 'e2']);
  const after = await call('GET', `/api/episodes/${episode.data.id}/events?format=json&after=${all.data.events[0].seq}`);
  assert.deepEqual(after.data.events.map(event => event.id), ['e2']);
  assert.equal(after.data.episode.turns, undefined);
  assert.equal((await call('GET', `/api/episodes/${episode.data.id}`, { user: 'someone-else' })).status, 402);
});

test('uploads are owner-scoped and the brand kit only accepts owned logos', async () => {
  const bad = await call('POST', '/api/uploads?kind=music&name=song.exe', { raw: 'x', type: 'application/octet-stream' });
  assert.equal(bad.status, 400);
  const svg = await call('POST', '/api/uploads?kind=logo&name=logo.svg', { raw: '<svg onload="alert(1)"></svg>', type: 'image/svg+xml' });
  assert.equal(svg.status, 400);
  const logo = await call('POST', '/api/uploads?kind=logo&name=logo.png', { raw: Buffer.from('89504e47', 'hex'), type: 'image/png' });
  assert.equal(logo.status, 201);
  const saved = await call('PUT', '/api/brand', { body: { name: 'Acme', logo: logo.data.asset, primaryColor: 'nope' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.primaryColor, '#101c24');
  assert.equal((await call('PUT', '/api/brand', { body: { logo: '/assets/someone-elses.png' } })).status, 400);
  assert.equal((await call('GET', logo.data.asset)).status, 200);
});

test('exports download timed transcripts and the public feed serves only included episode audio', async () => {
  const item = { id: store.uid(), ownerId: 'paid', status: 'complete', createdAt: new Date().toISOString(), mp4: '/assets/x.mp4', outline: { subject: 'Feed test' }, settings: {}, turns: [], events: [],
    timeline: [{ speaker: 'Hana (HOST)', role: 'host', text: 'Hello there.', start: 0, duration: 2 }], mp3: { url: await store.putNamedAsset('feed-test.mp3', Buffer.from('ID3fake')), bytes: 7, duration: 2 } };
  await store.addEpisode(item);
  const vtt = await call('GET', `/api/episodes/${item.id}/export?format=vtt`);
  assert.equal(vtt.status, 200);
  assert.match(vtt.data, /^WEBVTT/);
  assert.match(vtt.headers.get('content-disposition'), /Feed-test\.vtt/);
  assert.equal((await call('GET', `/api/episodes/${item.id}/export?format=vtt&lang=fr`)).status, 404);
  const feed = await call('PUT', '/api/feed', { body: { title: 'Acme Talks', author: 'Acme' } });
  assert.equal(feed.status, 200);
  const token = feed.data.token;
  let xml = await call('GET', `/feeds/${token}.xml`, { user: null });
  assert.equal(xml.status, 200);
  assert.doesNotMatch(xml.data, /Feed test/, 'episodes are not in the feed until added');
  assert.equal((await call('POST', `/api/episodes/${item.id}/feed`, { body: { include: true } })).status, 200);
  xml = await call('GET', `/feeds/${token}.xml`, { user: null });
  assert.match(xml.data, /feed-test\.mp3/);
  const media = await call('GET', `/feeds/${token}/media/feed-test.mp3`, { user: null });
  assert.equal(media.status, 200);
  assert.equal((await call('GET', `/feeds/${token}/media/other.mp3`, { user: null })).status, 404);
  assert.equal((await call('GET', `/feeds/${'0'.repeat(40)}.xml`, { user: null })).status, 404);
  const rotated = await call('PUT', '/api/feed', { body: { rotate: true } });
  assert.notEqual(rotated.data.token, token);
  assert.equal((await call('GET', `/feeds/${token}.xml`, { user: null })).status, 404, 'rotating the token retires the old URL');
  assert.equal((await call('POST', '/api/integrations/youtube/connect')).status, 409);
});
