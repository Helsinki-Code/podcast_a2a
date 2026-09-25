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
const { demoLeadInComplete, ownContext, speechPhrases } = await import('../lib/conversation.mjs');
const { buildCaptions, captionChunks, explainerCaptionFilter, explainerSceneBudget, requiredActionKinds, actionFingerprint, actionIsCompatible, buildExplainerDirectorState } = await import('../workflows/explainer-steps.mjs');
const { isSandboxNameConflict } = await import('../lib/vercel-sandbox.mjs');
const { parseProbeJson, parseSilenceLog, evaluateMediaQuality } = await import('../lib/media-quality.mjs');
const { podcastTimeline, podcastCaptions } = await import('../lib/podcast-timeline.mjs');
const { environmentReport } = await import('../lib/environment.mjs');
const { episodePlanHasContent } = await import('../lib/episode-plan.mjs');
const { assertPublicHttpUrl, isPrivateAddress } = await import('../lib/url-security.mjs');
await store.initStore();

test('retrieval returns only relevant source chunks', () => {
  const files = [{ name: 'solar.txt', text: 'Photovoltaic panels turn sunlight into electricity. Solar cells are installed on roofs.' }, { name: 'baking.txt', text: 'Bread needs flour and water.' }];
  const index = buildIndex(files);
  assert.equal(retrieve(index, 'How do solar panels work?')[0].source, 'solar.txt');
});

test('sandbox name conflicts are recognized for safe resume', () => {
  assert.equal(isSandboxNameConflict({ statusCode: 400, message: "A sandbox with the name 'podcast-id' already exists for this project." }), true);
  assert.equal(isSandboxNameConflict(new Error("Status code 400 is not ok: A sandbox with the name 'podcast-id' already exists for this project.")), true);
  assert.equal(isSandboxNameConflict({ statusCode: 500, message: 'Sandbox creation failed.' }), false);
});

test('browser targets reject local and private network addresses', async () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('169.254.169.254'), true);
  assert.equal(isPrivateAddress('10.20.30.40'), true);
  assert.equal(await assertPublicHttpUrl('https://example.com/path', { resolve: false }), 'https://example.com/path');
  await assert.rejects(assertPublicHttpUrl('http://localhost:3000', { resolve: false }), /Private network/);
  await assert.rejects(assertPublicHttpUrl('http://169.254.169.254/latest/meta-data', { resolve: false }), /Private network/);
});

test('computer use actions validate screenshot coordinates', () => {
  const prior = process.env.COMPUTER_USE_SNAPSHOT_ID;
  process.env.COMPUTER_USE_SNAPSHOT_ID = 'snap_test';
  try {
    assert.equal(actionIsCompatible({ type: 'click', x: 640, y: 420 }, {}), true);
    assert.equal(actionIsCompatible({ type: 'type', x: 640, y: 420, text: 'Visible input' }, {}), true);
    assert.equal(actionIsCompatible({ type: 'click', x: 2500, y: 420 }, {}), false);
    assert.equal(actionIsCompatible({ type: 'type', x: 640, y: 420, text: '' }, {}), false);
  } finally {
    if (prior == null) delete process.env.COMPUTER_USE_SNAPSHOT_ID; else process.env.COMPUTER_USE_SNAPSHOT_ID = prior;
  }
});

test('AI Gateway explainer voices reject legacy selections before generation', () => {
  assert.equal(providers.supportedVoice('gateway', 'coral', 'coral'), 'coral');
  assert.equal(providers.supportedVoice('gateway', 'marin', 'coral'), 'coral');
  assert.equal(providers.supportedVoice('gateway', 'cedar', 'coral'), 'coral');
  assert.equal(providers.supportedVoice('gateway', 'ballad', 'coral'), 'coral');
});

test('explainer captions use short timed cues instead of narration paragraphs', () => {
  const text = 'Create a campaign by entering the company website, choosing the lead count, selecting a target region, and reviewing the settings before continuing.';
  const chunks = captionChunks(text);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every(chunk => chunk.split(/\s+/).length <= 7 && chunk.length <= 52));
  const captions = buildCaptions([{ text, duration: 12 }]);
  assert.match(captions, /00:00:00,000 -->/);
  assert.match(captions, /--> 00:00:12,000/);
  assert.equal((captions.match(/-->/g) || []).length, chunks.length);
});

test('subtitle styles are user selectable and podcast speech stays conversational', () => {
  assert.match(explainerCaptionFilter('minimal'), /BorderStyle=1/);
  assert.match(explainerCaptionFilter('editorial'), /DejaVu Serif/);
  assert.match(explainerCaptionFilter('bold'), /Bold=1/);
  const custom = explainerCaptionFilter({ style: 'editorial', font: 'mono', size: 27, textColor: '#ffcc00', backgroundColor: '#112233', position: 'top' });
  assert.match(custom, /DejaVu Sans Mono/);
  assert.match(custom, /FontSize=27/);
  assert.match(custom, /Alignment=8/);
  const phrases = speechPhrases('This deliberately long sentence contains enough words to require several compact spoken phrases so the next voice can be prepared while the current phrase is still playing for the audience.');
  assert.ok(phrases.length >= 2);
  assert.ok(phrases.every(phrase => phrase.split(/\s+/).length <= 24));
});

test('explainer action history has stable fingerprints that prevent repeated scenes', () => {
  assert.equal(actionFingerprint({ type: 'type', selector: '@e4', value: 'example.com' }), 'type:@e4:example.com');
  assert.equal(actionFingerprint({ type: 'scroll', direction: 'down', amount: 400 }), actionFingerprint({ type: 'scroll', direction: 'down', amount: 900 }));
  assert.notEqual(actionFingerprint({ type: 'click', selector: '@e1' }), actionFingerprint({ type: 'click', selector: '@e2' }));
  const screen = { content: '- heading "Overview" [level=1, ref=e1]\n- link "Campaigns" [ref=e2]\n- textbox "Website" [ref=e3]' };
  assert.equal(actionIsCompatible({ type: 'click', selector: '@e1' }, screen), false);
  assert.equal(actionIsCompatible({ type: 'click', selector: '@e2' }, screen), true);
  assert.equal(actionIsCompatible({ type: 'type', selector: '@e3', value: 'example.com' }, screen), true);
  const consequential = { content: '- button "Approve all" [ref=e8]\n- button "Launch Campaign" [ref=e9]\n- button "Review sequences" [ref=e10]' };
  assert.equal(actionIsCompatible({ type: 'click', selector: '@e8' }, consequential), false);
  assert.equal(actionIsCompatible({ type: 'click', selector: '@e9' }, consequential), false);
  assert.equal(actionIsCompatible({ type: 'click', selector: '@e10' }, consequential), true);
  assert.equal(actionIsCompatible({ type: 'click', x: 500, y: 400 }, consequential), false);
});

test('explainer scene budget follows the requested brief instead of a fixed scene count', async () => {
  const short = { id: store.uid(), ownerId: 'owner', createdAt: store.stamp(), status: 'draft', url: 'https://example.com', title: 'Short', brief: 'Show the dashboard and explain the visible summary cards.' };
  const detailed = { ...short, id: store.uid(), title: 'Detailed', brief: '- Open the dashboard\n- Review the pipeline\n- Open one account\n- Explain its activity\n- Return to the dashboard\n- Show reports' };
  await store.saveExplainer(short); await store.saveExplainer(detailed);
  assert.notEqual(await explainerSceneBudget(short.id), await explainerSceneBudget(detailed.id));
});

test('explainer completion requirements follow interaction verbs in the brief', () => {
  assert.deepEqual(requiredActionKinds('Open New Campaign, enter a website, then scroll through the results.'), ['scroll', 'type', 'navigate']);
  assert.deepEqual(requiredActionKinds('Explain the visible dashboard without interacting.'), []);
});

test('explainer director receives structured live milestone state', () => {
  const state = buildExplainerDirectorState(
    ['navigate', 'scroll'],
    [{ action: { type: 'click', selector: '@e2' } }],
    [{ narration: 'Open the campaigns page.', action: { type: 'click', selector: '@e2' }, screenChanged: true }, { rejected: 'Do not repeat that link.' }],
    { title: 'Campaigns', content: '- link "New Campaign" [ref=e3]' },
    4,
    5
  );
  assert.deepEqual(state.requestedMilestones, ['navigate', 'scroll']);
  assert.deepEqual(state.completedMilestones, ['navigate']);
  assert.deepEqual(state.remainingMilestones, ['scroll']);
  assert.equal(state.scene.estimatedBudgetReached, true);
  assert.match(state.currentScreen.accessibility, /New Campaign/);
  assert.equal(state.previousActions.length, 1);
  assert.equal(state.rejectedDecisions.length, 1);
});

test('media quality rejects frozen interactive video and excessive silence', () => {
  const probe = parseProbeJson({ format: { duration: '141.3', size: '55720230', format_name: 'matroska,webm' }, streams: [{ codec_type: 'video', codec_name: 'vp9', width: 1920, height: 1080, avg_frame_rate: '60/1' }, { codec_type: 'audio', codec_name: 'opus', sample_rate: '48000', channels: 2 }] });
  assert.equal(probe.duration, 141.3);
  assert.equal(probe.video.frameRate, 60);
  const silence = parseSilenceLog('silence_start: 0.025\nsilence_end: 12.254625 | silence_duration: 12.229625\nsilence_start: 16.426938\nsilence_end: 26.366104 | silence_duration: 9.939166', probe.duration);
  const verdict = evaluateMediaQuality({ ...probe, sceneChanges: 0, uniqueFrames: 1, silence, timestampErrors: 3 }, { interactive: true });
  assert.equal(verdict.passed, false);
  assert.match(verdict.failures.join(' '), /no meaningful visual changes/i);
  assert.match(verdict.failures.join(' '), /longest unintended silence/i);
  assert.match(verdict.failures.join(' '), /timestamps/i);
});

test('media quality accepts a changing narrated MP4', () => {
  const verdict = evaluateMediaQuality({ duration: 45, video: { codec: 'h264' }, audio: { codec: 'aac' }, sceneChanges: 8, uniqueFrames: 70, silence: { percentage: 4, longest: .4 }, timestampErrors: 0 }, { interactive: true, minDuration: 20 });
  assert.deepEqual(verdict, { passed: true, failures: [] });
});

test('podcast timeline excludes generation waits and includes browser action media', () => {
  const events = [
    { type: 'thinking', at: '2026-01-01T00:00:00Z', role: 'host' },
    { type: 'speech', at: '2026-01-01T00:00:14Z', role: 'host', text: 'Welcome to the show.', audio: '/api/audio/a' },
    { type: 'thinking', at: '2026-01-01T00:00:40Z', role: 'guest' },
    { type: 'speech', at: '2026-01-01T00:01:02Z', role: 'guest', text: 'I will show the product.', audio: '/api/audio/b' },
    { type: 'tool_end', at: '2026-01-01T00:02:00Z', role: 'guest', tool: 'browser', screen: { video: '/assets/action.mp4', image: '/assets/screen.png' } },
    { type: 'speech', at: '2026-01-01T00:03:30Z', role: 'host', text: 'The dashboard is visible now.', audio: '/api/audio/c' }
  ];
  const timeline = podcastTimeline(events);
  assert.deepEqual(timeline.map(item => item.type), ['speech', 'speech', 'browser', 'speech']);
  assert.equal(timeline[3].screen, '/assets/screen.png');
  assert.equal(timeline.some(item => item.type === 'thinking'), false);
  const captions = podcastCaptions([{ ...timeline[0], start: 0, audioDuration: 2 }, { ...timeline[1], start: 2.14, audioDuration: 2.5 }]);
  assert.match(captions, /HOST: Welcome to the show/);
  assert.match(captions, /GUEST: I will show the product/);
  assert.doesNotMatch(captions, /00:01:02/);
});

test('environment report names missing configuration without exposing values or requiring E2B', () => {
  const report = environmentReport({ DATABASE_URL: 'secret-db', NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk', CLERK_SECRET_KEY: 'sk', BLOB_READ_WRITE_TOKEN: 'blob', STRIPE_SECRET_KEY: 'stripe', STRIPE_WEBHOOK_SECRET: 'wh', STRIPE_PRICE_STARTER: 'a', STRIPE_PRICE_PRO: 'b', STRIPE_PRICE_SCALE: 'c', COMPUTER_USE_SNAPSHOT_ID: 'snap', VERCEL: '1' });
  assert.equal(report.ready, true);
  assert.doesNotMatch(JSON.stringify(report), /secret-db|stripe|blob/);
  assert.equal(JSON.stringify(report).includes('E2B_TEMPLATE'), false);
  const missing = environmentReport({ VERCEL: '1' });
  assert.equal(missing.ready, false);
  assert.ok(missing.features.auth.missing.includes('CLERK_SECRET_KEY'));
});

test('guest context requires a real browser demo without exposing login secrets', () => {
  const episode = { outline: { subject: 'Platform overview', angle: 'private', points: '' }, turns: [{ role: 'host', text: 'Welcome.' }, { role: 'guest', text: 'Thanks.' }, { role: 'host', text: 'What problem does it solve?' }], events: [], settings: { hostTools: false, requireGuestDemo: true, demo: { url: 'https://example.com/app', brief: 'Show the dashboard.', authRequired: true } } };
  const messages = ownContext(episode, 'guest', { systemPrompt: 'Explain clearly.', knowledge: [] }, { type: 'browser', title: 'Dashboard', content: 'Overview' }, 'turn');
  const text = JSON.stringify(messages);
  assert.equal(demoLeadInComplete(episode), true);
  assert.match(text, /transition naturally into the required live computer demonstration/);
  assert.match(text, /https:\/\/example\.com\/app/);
  assert.doesNotMatch(text, /hunter2|secret@example\.com/i);
});

test('podcast opening keeps browser actions behind a two-way conversation lead-in', () => {
  const episode = { outline: { subject: 'Platform overview', angle: '', points: '' }, turns: [{ role: 'host', text: 'Welcome to the show.' }], events: [], settings: { hostTools: false, requireGuestDemo: true, demo: { url: 'https://example.com/app', brief: 'Show the dashboard.' } } };
  const text = JSON.stringify(ownContext(episode, 'guest', { systemPrompt: 'Explain clearly.', knowledge: [] }, { type: 'idle' }, 'turn'));
  assert.equal(demoLeadInComplete(episode), false);
  assert.match(text, /do not use the browser yet/);
});

test('podcast visual plans must contain usable speech or actions', () => {
  assert.equal(episodePlanHasContent({ narration: 'Wrong explainer shape', action: { type: 'click' }, done: false }), false);
  assert.equal(episodePlanHasContent({ segments: [] }), false);
  assert.equal(episodePlanHasContent({ segments: [{ type: 'speak', text: 'I can see the dashboard now.' }] }), true);
  assert.equal(episodePlanHasContent({ segments: [{ type: 'act', tool: 'browser', input: { action: 'scroll' } }] }), true);
  assert.equal(episodePlanHasContent({ interrupt: false }, 'interrupt'), true);
});

test('restart copies production inputs into a clean attempt without reusing outputs or charges', async () => {
  const episode = await store.copyEpisodeForRestart({ id: 'old-episode', ownerId: 'owner', createdAt: 'old', status: 'stopped', outline: { subject: 'Same show' }, settings: { demo: { url: 'https://example.com' } }, personas: { host: {}, guest: {} }, turns: [{ role: 'host', text: 'Old audio' }], events: [{ type: 'speech' }], video: '/assets/old.webm', creditsCharged: 20, demoPrepared: true });
  assert.equal(episode.status, 'draft');
  assert.equal(episode.outline.subject, 'Same show');
  assert.deepEqual(episode.turns, []);
  assert.equal(episode.video, undefined);
  assert.equal(episode.creditsCharged, undefined);
  assert.equal(episode.demoPrepared, false);
  const explainer = await store.copyExplainerForRestart({ id: 'old-explainer', ownerId: 'owner', createdAt: 'old', status: 'complete', title: 'Same explainer', url: 'https://example.com', brief: 'Show the same workflow again.', authRequired: true, browserPrepared: true, video: '/assets/old.mp4', actions: [{ type: 'click', selector: '@e1' }], creditsCharged: 30 });
  assert.equal(explainer.status, 'draft');
  assert.equal(explainer.title, 'Same explainer');
  assert.equal(explainer.video, undefined);
  assert.equal(explainer.actions, undefined);
  assert.equal(explainer.creditsCharged, undefined);
  assert.equal(explainer.browserPrepared, false);
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
