import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationLoop, nextRoleAfter, runConversation } from '../lib/conversation-loop.mjs';
import { friendlyError } from '../public/errors.js';
import { podcastOutputSpec } from '../lib/podcast-assembly.mjs';

const guestAnswer = 'The dashboard groups every campaign by stage, so a rep can see which accounts need attention first and act on them without digging through separate reports or spreadsheets every single morning.';

function fakeIo(item, plans, overrides = {}) {
  const calls = { waiters: 0, published: [], notices: [], plans: [] };
  const io = {
    begin: async () => {}, finish: async (id, status, error) => { item.status = status; item.error = error; },
    snapshot: async () => item, expired: async () => false, newEventId: async () => `e${calls.published.length}`,
    plan: async (id, role, screen, mode, extra) => { calls.plans.push({ role, extra }); const next = plans.shift(); if (!next) return { segments: [{ type: 'speak', text: 'Thanks, that wraps it up.' }], finish: true }; if (next instanceof Error) throw next; return typeof next === 'function' ? next(role) : next; },
    prepareSpeech: async (id, role, text) => ({ audio: `/api/audio/${text.length}` }),
    publishSpeech: async (id, role, text, eventId, prepared, acknowledged) => { calls.published.push({ role, text, acknowledged }); item.turns.push({ role, text }); },
    playbackWaiter: async () => { calls.waiters++; return { wait: async () => ({ played: true }), dispose() {} }; },
    act: async () => ({ type: 'diagram', title: 'x', content: '' }),
    emitNotice: async (id, message) => calls.notices.push(message), emitInterruption: async () => {}, interjectionVerdict: async () => ({ interrupt: false }),
    ...overrides
  };
  return { io, calls };
}
const episode = settings => ({ id: 'ep', turns: [], settings: { interjections: false, requireGuestDemo: false, ...settings }, outline: { subject: 'Test' } });

test('background mode publishes pre-acknowledged speech and never waits for a player', async () => {
  const item = episode({ playbackMode: 'background' });
  const { io, calls } = fakeIo(item, [{ segments: [{ type: 'speak', text: 'Welcome to the show.' }] }, { segments: [{ type: 'speak', text: guestAnswer }] }]);
  await conversationLoop('ep', io);
  assert.equal(calls.waiters, 0);
  assert.ok(calls.published.length >= 3);
  assert.ok(calls.published.every(entry => entry.acknowledged === true));
});

test('live mode waits for playback of every line', async () => {
  const item = episode({});
  const { io, calls } = fakeIo(item, [{ segments: [{ type: 'speak', text: 'Welcome to the show.' }] }, { segments: [{ type: 'speak', text: guestAnswer }] }]);
  await conversationLoop('ep', io);
  assert.equal(calls.waiters, calls.published.length);
});

test('durable live mode publishes and waits without binding the workflow adapter as this', async () => {
  const item = episode({});
  const { io, calls } = fakeIo(item, [{ segments: [{ type: 'speak', text: 'Welcome to the show.' }] }, { segments: [{ type: 'speak', text: guestAnswer }] }]);
  io.publishSpeechAndWait = async function (id, role, text) {
    assert.equal(this, undefined, 'workflow callbacks must not receive the function-bearing adapter as thisVal');
    calls.published.push({ role, text, acknowledged: false });
    item.turns.push({ role, text });
    return { played: true };
  };
  await conversationLoop('ep', io);
  assert.equal(calls.waiters, 0, 'the durable path does not return wait/dispose closures');
  assert.ok(calls.published.length >= 3);
});

test('a failed turn is regenerated with a hint, then handed to the other persona', async () => {
  const item = episode({});
  const { io, calls } = fakeIo(item, [new Error('No object generated: could not parse the response.'), new Error('still broken'), { segments: [{ type: 'speak', text: guestAnswer }] }]);
  await conversationLoop('ep', io);
  assert.equal(calls.plans[0].role, 'host');
  assert.match(calls.plans[1].extra, /could not be used/);
  assert.equal(calls.plans[1].role, 'host');
  assert.equal(calls.plans[2].role, 'guest');
  assert.equal(calls.notices.length, 2);
});

test('repeated failures wrap up a usable conversation instead of failing it', async () => {
  const item = episode({});
  item.turns = [{ role: 'host', text: 'a' }, { role: 'guest', text: 'b' }, { role: 'host', text: 'c' }, { role: 'guest', text: 'd' }];
  const failure = new Error('gateway down');
  const { io, calls } = fakeIo(item, [failure, failure, failure, failure]);
  await runConversation('ep', io);
  assert.equal(item.status, 'complete');
  assert.match(calls.notices.at(-1), /wrapped up/);
});

test('repeated failures before anything usable fail the episode', async () => {
  const item = episode({});
  const failure = new Error('gateway down');
  const { io } = fakeIo(item, [failure, failure, failure, failure]);
  await runConversation('ep', io);
  assert.equal(item.status, 'failed');
  assert.equal(item.error, 'gateway down');
});

test('a line whose voice fails is skipped without ending the episode', async () => {
  const item = episode({});
  let failed = false;
  const first = 'First block of the opening, with enough words that the host line has to be voiced in two separate requests because it runs well past the forty eight word limit for one natural block of host speech in this show.';
  const { io, calls } = fakeIo(item, [{ segments: [{ type: 'speak', text: `${first} Second block closes the opening with a question for the guest about the product?` }] }, { segments: [{ type: 'speak', text: guestAnswer }] }], {
    prepareSpeech: async (id, role, text) => { if (!failed && text.startsWith('First')) { failed = true; throw new Error('TTS 500'); } return { audio: '/api/audio/x' }; }
  });
  await conversationLoop('ep', io);
  assert.ok(!calls.published.some(entry => entry.text.startsWith('First')));
  assert.ok(calls.published.some(entry => entry.text.startsWith('Second')));
  assert.match(calls.notices[0], /skipped/);
});

test('resume continues with the persona who did not speak last', () => {
  assert.equal(nextRoleAfter([]), 'host');
  assert.equal(nextRoleAfter([{ role: 'host' }]), 'guest');
  assert.equal(nextRoleAfter([{ role: 'host' }, { role: 'guest' }]), 'host');
});

test('friendly errors explain common failures with a next step', () => {
  assert.equal(friendlyError(''), null);
  assert.match(friendlyError('Playback client did not acknowledge speech within five minutes.').hint, /Background/);
  assert.equal(friendlyError('The recording workflow failed: Failed to serialize step arguments at .thisVal.playbackWaiter').title, 'The recording workflow stopped');
  assert.match(friendlyError('This podcast needs 20 credits.').title, /credits/);
  assert.match(friendlyError('Podcast quality check failed: frozen video').title, /quality/);
  assert.equal(friendlyError('weird').title, 'Something went wrong');
});

test('podcast output follows the chosen resolution and format', () => {
  assert.deepEqual(podcastOutputSpec({ width: 1280, height: 720, outputFormat: 'mp4' }), { width: 1280, height: 720, format: 'mp4' });
  assert.deepEqual(podcastOutputSpec({}), { width: 1920, height: 1080, format: 'both' });
});
