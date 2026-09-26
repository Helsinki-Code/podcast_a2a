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

test('persona knowledge is kept by name, stats replace raw text, and test chat cites real files', async () => {
  const providers = await import('../lib/providers.mjs');
  let seenSystem = '';
  providers.registerModel('persona-test', { ready: () => true, async generate(messages) { seenSystem = messages[0].content; return { reply: 'Our onboarding guide says setup takes a day.', sources: ['guide.txt', 'invented.txt'] }; } });
  providers.registerSpeech('preview-test', { ready: () => true, voices: ['v1'], async synthesize(text) { return Buffer.from(`mp3:${text}`); } });
  const created = await call('POST', '/api/personas', { body: { name: 'Ana', systemPrompt: 'Explain onboarding.', modelProvider: 'persona-test', knowledge: [{ name: 'guide.txt', text: 'Onboarding setup takes one day with the import wizard. '.repeat(40) }, { name: 'faq.txt', text: 'Pricing is per seat.' }] } });
  assert.equal(created.status, 201);
  assert.equal(created.data.knowledgeIndex, undefined, 'embedding index is never sent to the browser');
  assert.deepEqual(created.data.knowledge.map(file => file.name), ['guide.txt', 'faq.txt']);
  assert.equal(created.data.knowledge[0].text, undefined);
  assert.ok(created.data.knowledgeStats.chunks >= 2);
  const updated = await call('PUT', `/api/personas/${created.data.id}`, { body: { name: 'Ana', systemPrompt: 'Explain onboarding.', modelProvider: 'persona-test', knowledge: [{ name: 'guide.txt', keep: true }, { name: 'web.txt', text: 'Fresh page text about integrations.', source: 'https://example.com/p' }] } });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data.knowledge.map(file => [file.name, file.characters > 0, file.source]), [['guide.txt', true, ''], ['web.txt', true, 'https://example.com/p']]);
  const stored = await store.persona(created.data.id);
  assert.match(stored.knowledge[0].text, /import wizard/, 'kept files retain their server-side text');
  const chat = await call('POST', `/api/personas/${created.data.id}/chat`, { body: { message: 'How long does onboarding setup take?' } });
  assert.equal(chat.status, 200);
  assert.deepEqual(chat.data.sources, ['guide.txt']);
  assert.match(seenSystem, /import wizard/);
  const preview = await fetch(`${base}/api/voices/preview`, { method: 'POST', headers: { Authorization: 'Bearer paid', 'Content-Type': 'application/json' }, body: JSON.stringify({ speechProvider: 'preview-test', voice: 'v1', name: 'Ana' }) });
  assert.equal(preview.headers.get('content-type'), 'audio/mpeg');
  assert.match(await preview.text(), /mp3:Hi, I'm Ana/);
  const templates = await call('GET', '/api/persona-templates');
  assert.ok(templates.data.length >= 5 && templates.data.every(template => template.systemPrompt && template.voice));
});

test('teams: invite by email, accept into the owner scope, viewer is read-only, billing is owner-only', async () => {
  const invite = await call('POST', '/api/team/invites', { body: { email: 'owner@example.com', role: 'viewer' } });
  assert.equal(invite.status, 201);
  assert.match(invite.data.link, /\?invite=[a-f0-9]{64}$/);
  // primaryEmail is mocked to owner@example.com for everyone, so "member" can accept the invite.
  assert.equal((await call('POST', '/api/team/accept', { user: 'member', body: { token: 'bad' } })).status, 404);
  const accepted = await call('POST', '/api/team/accept', { user: 'member', body: { token: invite.data.invite.token } });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  const me = await call('GET', '/api/auth/me', { user: 'member' });
  assert.equal(me.data.role, 'viewer');
  assert.equal(me.data.workspaceId, 'paid');
  const personas = await call('GET', '/api/personas', { user: 'member' });
  assert.equal(personas.status, 200, 'members see the paid owner workspace');
  assert.ok(personas.data.some(item => item.name === 'Hana'));
  assert.equal((await call('POST', '/api/personas', { user: 'member', body: { name: 'X', systemPrompt: 'y' } })).status, 403);
  assert.equal((await call('POST', '/api/billing/topup', { user: 'member', body: { pack: 'small' } })).status, 403);
  const team = await call('GET', '/api/team');
  assert.deepEqual(team.data.members.map(member => [member.userId, member.role]), [['member', 'viewer']]);
  assert.equal((await call('PATCH', '/api/team/members/member', { body: { role: 'editor' } })).status, 200);
  assert.equal((await call('POST', '/api/personas', { user: 'member', body: { name: 'Editor made', systemPrompt: 'y' } })).status, 201);
  assert.equal((await call('POST', '/api/team/invites', { user: 'member', body: { email: 'a@b.co' } })).status, 403, 'editors cannot invite');
  assert.equal((await call('POST', '/api/team/leave', { user: 'member' })).status, 200);
  assert.equal((await call('GET', '/api/personas', { user: 'member' })).status, 402, 'after leaving, the member has no paid workspace');
});

test('credits history, rate limits, deletion, and retention settings', async () => {
  const credits = await call('GET', '/api/credits');
  assert.equal(credits.status, 200);
  assert.ok(credits.data.ledger.some(row => row.kind === 'test'));
  assert.equal(credits.data.topUps.length, 3);
  process.env.RATE_LIMITS_JSON = JSON.stringify({ 'ai-tools': 2 });
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await call('POST', '/api/voices/preview', { user: 'limited', body: {} })).status);
  delete process.env.RATE_LIMITS_JSON;
  assert.equal(codes[2], 429);
  const item = { id: store.uid(), ownerId: 'paid', status: 'complete', createdAt: new Date().toISOString(), outline: { subject: 'Delete me' }, settings: {}, turns: [], events: [], mp4: await store.putNamedAsset('delete-me.mp4', Buffer.from('x')) };
  await store.addEpisode(item);
  const deleted = await call('DELETE', `/api/episodes/${item.id}`);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.filesRemoved, 1);
  assert.equal(await store.episode(item.id), undefined);
  const settings = await call('PUT', '/api/settings', { body: { retentionDays: 90 } });
  assert.equal(settings.data.retentionDays, 90);
  assert.equal((await call('GET', '/api/cron/retention', { user: null })).status, 401);
});
