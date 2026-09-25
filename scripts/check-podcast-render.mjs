import '../lib/env.mjs';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';
import { del, get } from '@vercel/blob';
import { initStore, addEpisode, episode, putNamedAsset, uid, stamp } from '../lib/store.mjs';
import { renderPodcastTimeline } from '../workflows/podcast-render-steps.mjs';

const id = uid();
const ownerId = `podcast_render_check_${Date.now()}`;
const created = [];
const make = (args, output) => { execFileSync('ffmpeg', ['-y', ...args, output], { stdio: 'ignore' }); return output; };
const speech1 = make(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2.2', '-c:a', 'libmp3lame'], `/tmp/${id}-host.mp3`);
const speech2 = make(['-f', 'lavfi', '-i', 'sine=frequency=550:sample_rate=48000', '-t', '2.4', '-c:a', 'libmp3lame'], `/tmp/${id}-guest.mp3`);
const speech3 = make(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-t', '2.0', '-c:a', 'libmp3lame'], `/tmp/${id}-host2.mp3`);
const action = make(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '2.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an'], `/tmp/${id}-action.mp4`);
const screenshot = make(['-f', 'lavfi', '-i', 'color=c=0x17353d:s=1920x1080', '-frames:v', '1'], `/tmp/${id}-screen.png`);
const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

try {
  await initStore();
  const upload = async (name, filename) => { const url = await putNamedAsset(name, await readFile(filename)); created.push(`assets/${name}`); return url; };
  const [hostAudio, guestAudio, hostAudio2, browserVideo, browserImage] = await Promise.all([
    upload(`${id}-host.mp3`, speech1), upload(`${id}-guest.mp3`, speech2), upload(`${id}-host2.mp3`, speech3), upload(`${id}-action.mp4`, action), upload(`${id}-screen.png`, screenshot)
  ]);
  await addEpisode({
    id, ownerId, createdAt: stamp(), status: 'complete', outline: { subject: 'Timeline render verification' },
    personas: { host: { name: 'Test Host' }, guest: { name: 'Test Guest' } },
    settings: { requireGuestDemo: true, captionStyle: 'studio', accent: '#80ded1', guestAccent: '#efbe9e', background: '#101c24' },
    turns: [],
    events: [
      { type: 'speech', role: 'host', text: 'Welcome. We will inspect the working browser together.', audio: hostAudio.replace('/assets/', '/api/audio/').replace(/\.mp3$/, '') },
      { type: 'speech', role: 'guest', text: 'I will open the real interface after our introduction.', audio: guestAudio.replace('/assets/', '/api/audio/').replace(/\.mp3$/, '') },
      { type: 'tool_end', role: 'guest', tool: 'browser', screen: { video: browserVideo, image: browserImage } },
      { type: 'speech', role: 'host', text: 'The live browser action is now visible in the finished episode.', audio: hostAudio2.replace('/assets/', '/api/audio/').replace(/\.mp3$/, '') }
    ]
  });
  await renderPodcastTimeline(id);
  const final = await episode(id);
  if (final.videoStatus !== 'complete' || !final.mp4 || !final.captions || !final.quality) throw new Error(final.videoError || 'Podcast timeline render did not complete.');
  const videoBlob = await get(`assets/${final.mp4.split('/').pop()}`, { access: 'private' });
  const output = Buffer.from(await new Response(videoBlob.stream).arrayBuffer());
  await writeFile('/tmp/sales-forge-podcast-render-check.mp4', output);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', '/tmp/sales-forge-podcast-render-check.mp4'], { encoding: 'utf8' }));
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  const audio = probe.streams.find(stream => stream.codec_type === 'audio');
  if (video?.codec_name !== 'h264' || audio?.codec_name !== 'aac') throw new Error('Rendered podcast is not H.264/AAC.');
  console.log(JSON.stringify({ mp4: final.mp4, captions: final.captions, duration: Number(probe.format.duration), size: Number(probe.format.size), quality: final.quality, local: '/tmp/sales-forge-podcast-render-check.mp4' }, null, 2));
  created.push(`assets/${final.mp4.split('/').pop()}`, `assets/${final.captions.split('/').pop()}`);
} finally {
  await sql`DELETE FROM podcast_episodes WHERE id = ${id}`.catch(() => {});
  if (created.length) await del(created).catch(() => {});
}
