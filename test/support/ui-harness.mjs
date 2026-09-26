import { register } from 'node:module';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Runs the real server against a throwaway local store with fake Clerk auth and seeded data, and
// gives Playwright a page whose Clerk bundle is stubbed. Used by UI tests and screenshots.
register('./auth-loader.mjs', import.meta.url);

export async function startHarness({ seed = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ui-harness-'));
  process.chdir(dir);
  delete process.env.DATABASE_URL;
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= 'pk_test_harness';
  const store = await import('../../lib/store.mjs');
  const { handler } = await import('../../server.mjs');
  await store.initStore();
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  if (seed) await seedDemo(store);
  return { base, store, dir, close: () => new Promise(resolve => server.close(resolve)) };
}

export const CLERK_STUB = user => `window.createSalesForgeClerk = async () => ({ user: ${user ? `{ id: ${JSON.stringify(user)} }` : 'null'}, session: { getToken: async () => ${JSON.stringify(user || '')} }, addListener() {}, mountUserButton(el) { el.textContent = 'You'; }, openSignIn() {}, signOut() {} });`;

export async function openApp(browser, base, { user = 'owner', viewport = { width: 1440, height: 900 }, colorScheme = 'light', path: route = '/' } = {}) {
  const context = await browser.newContext({ viewport, colorScheme });
  const page = await context.newPage();
  await page.route('**/public/clerk.bundle.js', r => r.fulfill({ contentType: 'text/javascript', body: CLERK_STUB(user) }));
  await page.route('**/public/blob-upload.bundle.js', r => r.fulfill({ contentType: 'text/javascript', body: 'window.uploadPodcastVideo = async () => "";' }));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + route);
  return { page, context, errors };
}

// Real (tiny) media for the seeded items when ffmpeg is available, so players and thumbnails load.
function makeMedia(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}
async function seedMedia(store) {
  const video = makeMedia(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=50', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=50', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4']);
  const thumb = makeMedia(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720', '-frames:v', '1', '-f', 'mjpeg']);
  if (video) { await store.putNamedAsset('demo-episode.mp4', video); await store.putNamedAsset('demo-explainer.mp4', video); }
  if (thumb) await store.putNamedAsset('demo-thumb.jpg', thumb);
}

export async function seedDemo(store, owner = 'owner') {
  await seedMedia(store);
  await store.account(owner, `${owner}@example.com`);
  await store.updateSubscription(owner, { subscriptionStatus: 'active', plan: 'pro', periodEnd: new Date(Date.now() + 20 * 86400000).toISOString() });
  await store.grantCredits(owner, 300, 'subscription_cycle', 'in_demo', `invoice:demo-${owner}`);
  const now = Date.now();
  const personas = [];
  for (const [name, prompt, voice] of [['Maya Chen', 'Curious host who asks specific questions.', 'coral'], ['Daniel Okafor', 'Founder who explains with concrete examples.', 'onyx'], ['Priya Raman', 'Industry analyst.', 'nova']]) {
    personas.push(await store.addPersona({ id: store.uid(), ownerId: owner, createdAt: new Date(now - 9e6).toISOString(), name, systemPrompt: prompt, voice, speechProvider: 'gateway', modelProvider: 'gateway', knowledge: [{ name: 'notes.txt', text: 'Some notes about the product and customers.' }], knowledgeIndex: [] }));
  }
  const timeline = [
    { speaker: 'Maya Chen (HOST)', role: 'host', text: 'Welcome to the show. Daniel, what problem does your planning tool solve?', start: 4.5, duration: 5 },
    { speaker: 'Daniel Okafor (GUEST)', role: 'guest', text: 'Account teams drown in dashboards. We pick the three deals that need attention this week and explain why.', start: 9.5, duration: 9 },
    { speaker: 'Maya Chen (HOST)', role: 'host', text: 'How does a rep use it on a Monday morning?', start: 30, duration: 4 },
    { speaker: 'Daniel Okafor (GUEST)', role: 'guest', text: 'They open the board, sort by risk, and start with the first account. It takes about five minutes.', start: 34, duration: 10 }
  ];
  const cast = { host: personas[0], guest: personas[1] };
  const complete = { id: store.uid(), ownerId: owner, createdAt: new Date(now - 864e5).toISOString(), status: 'complete', hostId: personas[0].id, guestId: personas[1].id, personas: cast, outline: { subject: 'Planning the sales week with AI' }, settings: { width: 1920, height: 1080, targetMinutes: 8, playbackMode: 'background', music: { intro: true, outro: true } }, turns: timeline.map(part => ({ role: part.role, text: part.text })), events: timeline.map((part, index) => ({ id: `s${index}`, seq: index + 1, type: 'speech', role: part.role, text: part.text, audio: '/api/audio/00000000-0000-0000-0000-00000000000' + index, acknowledged: true })), videoStatus: 'complete', mp4: '/assets/demo-episode.mp4', captions: '/assets/demo-episode.srt', thumbnail: '/assets/demo-thumb.jpg', mp3: { url: '/assets/demo.mp3', bytes: 1000, duration: 50 }, timeline, duration: 50, chapters: [{ start: 0, title: 'The problem' }, { start: 30, title: 'Monday routine' }], youtube: { title: 'Planning the sales week with AI', description: 'How account teams pick the deals that matter.', tags: ['sales', 'ai'] }, startedAt: new Date(now - 864e5).toISOString(), endedAt: new Date(now - 86e6).toISOString() };
  const failed = { ...structuredClone(complete), id: store.uid(), createdAt: new Date(now - 36e5).toISOString(), status: 'failed', error: 'Playback client did not acknowledge speech within five minutes.', outline: { subject: 'Pricing experiments that worked' }, mp4: null, videoStatus: null, timeline: null, chapters: null, thumbnail: null, duration: null, mp3: null };
  const draft = { ...structuredClone(complete), id: store.uid(), createdAt: new Date(now - 6e5).toISOString(), status: 'draft', outline: { subject: 'Onboarding in one day' }, turns: [], events: [], mp4: null, videoStatus: null, timeline: null, chapters: null, thumbnail: null, duration: null, mp3: null };
  for (const item of [complete, failed, draft]) await store.addEpisode(item);
  await store.saveExplainer({ id: store.uid(), ownerId: owner, createdAt: new Date(now - 72e5).toISOString(), status: 'complete', title: 'Pipeline dashboard tour', url: 'https://app.example.com', brief: 'Tour the dashboard and open one deal.', video: '/assets/demo-explainer.mp4', captions: '/assets/demo-explainer.srt', summary: 'A two-minute tour of the pipeline dashboard.', chapters: [{ start: 0, title: 'Dashboard' }, { start: 20, title: 'Deal detail' }], scenes: [{ text: 'This is the pipeline dashboard.', title: 'Dashboard', video: '/assets/s0.mp4', duration: 6 }], timeline: [{ speaker: '', text: 'This is the pipeline dashboard.', start: 0, duration: 6 }], voice: 'coral', captionOptions: {} });
  await store.saveExplainer({ id: store.uid(), ownerId: owner, createdAt: new Date(now - 6e4).toISOString(), status: 'awaiting_approval', title: 'Create a campaign', url: 'https://app.example.com/campaigns', brief: 'Create a new campaign without launching it.', plan: { approved: false, scenes: [{ title: 'Open campaigns', goal: 'Click Campaigns', narration: 'We start in the Campaigns area.' }, { title: 'New campaign', goal: 'Click New campaign', narration: 'Here is where a new campaign begins.' }] } });
  return { personas, episodes: [complete, failed, draft] };
}
