import '../lib/env.mjs';
import { writeFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';
import { get } from '@vercel/blob';
import { registerModel, registerSpeech } from '../lib/providers.mjs';
import { runEpisode } from '../lib/engine.mjs';
import { save, stamp, uid } from '../lib/store.mjs';

let hostCalls = 0;
let guestCalls = 0;
registerModel('podcast-computer-check', {
  ready: () => true,
  async generate(messages) {
    const system = String(messages[0]?.content || '');
    const host = /You are the host\b/.test(system);
    if (host) {
      hostCalls++;
      if (hostCalls === 1) return { segments: [{ type: 'speak', text: 'Welcome. Before we open the browser, what problem does this example solve?' }], finish: false };
      if (hostCalls === 2) return { segments: [{ type: 'speak', text: 'Show us the real page when you are ready, and explain what changes.' }], finish: false };
      return { segments: [{ type: 'speak', text: 'The page changed on screen, and that completes the live demonstration.' }], finish: true };
    }
    guestCalls++;
    if (guestCalls === 1) return { segments: [{ type: 'speak', text: 'It gives documentation a safe public domain without using a production website.' }], finish: false };
    if (guestCalls === 2) return { segments: [{ type: 'speak', text: 'I will open the real page now so we can inspect it together.' }, { type: 'act', tool: 'browser', input: { action: 'visit', url: 'https://example.com' } }], finish: false };
    return { segments: [{ type: 'speak', text: 'The browser is showing the actual Example Domain page, including its documentation link.' }], finish: false };
  }
});
registerSpeech('podcast-computer-check', { ready: () => true, voices: ['check'], async synthesize() { return Buffer.from('ID3'); } });

const id = uid();
const ownerId = `podcast_computer_check_${Date.now()}`;
const persona = role => ({ id: `${role}-${id}`, ownerId, name: role === 'host' ? 'Test Host' : 'Test Guest', systemPrompt: `You are the ${role}.`, knowledge: [], knowledgeIndex: [], modelProvider: 'podcast-computer-check', speechProvider: 'podcast-computer-check', voice: 'check' });
const episode = {
  id, ownerId, createdAt: stamp(), status: 'draft', outline: { subject: 'Example Domain', angle: '', points: '' },
  personas: { host: persona('host'), guest: persona('guest') }, turns: [], events: [],
  settings: { maxMinutes: 2, interjections: false, interjectProbability: 0, hostTools: false, requireGuestDemo: true, demo: { url: 'https://example.com', brief: 'Show the real page.' } }
};
const published = [];
const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
try {
  await save(episode);
  await runEpisode(episode, (_episodeId, event) => published.push(event), async () => {});
  if (episode.status !== 'complete') throw new Error(`Podcast check failed: ${episode.error || episode.status}`);
  const toolIndex = published.findIndex(event => event.type === 'tool_start' && event.role === 'guest' && event.tool === 'browser');
  const precedingSpeech = published.slice(0, toolIndex).filter(event => event.type === 'speech');
  if (toolIndex < 0 || precedingSpeech.length < 4) throw new Error('The guest used Computer Use before the host and guest completed the conversational introduction.');
  if (!/open the real page/i.test(precedingSpeech.at(-1)?.text || '')) throw new Error('The guest did not narrate the browser transition before acting.');
  const finished = published.find(event => event.type === 'tool_end' && event.role === 'guest' && event.tool === 'browser');
  if (!finished?.screen?.video || !finished?.screen?.image || !finished?.screen?.liveUrl) throw new Error('The guest Computer Use result is missing its action video, screenshot, or live desktop URL.');
  const filename = finished.screen.video.split('/').pop();
  const blob = await get(`assets/${filename}`, { access: 'private' });
  const bytes = Buffer.from(await new Response(blob.stream).arrayBuffer());
  if (bytes.length < 10_000) throw new Error('The guest browser action MP4 is unexpectedly small.');
  await writeFile('/tmp/podcast-computer-use-check.mp4', bytes);
  console.log(`podcast Computer Use verified: ${precedingSpeech.length} spoken segments before browser, guest narration before action, host reaction after action, ${bytes.length} byte MP4 · /tmp/podcast-computer-use-check.mp4`);
} finally {
  await sql`DELETE FROM podcast_episodes WHERE id = ${id}`.catch(() => {});
}
