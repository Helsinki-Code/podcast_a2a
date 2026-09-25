import '../lib/env.mjs';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';
import { put, head, del } from '@vercel/blob';
import { initStore, addEpisode, episode, uid, stamp } from '../lib/store.mjs';
import { podcastVideoWorkflow } from '../workflows/podcast-video.mjs';

const id = uid();
const pathname = `assets/episode-${id}-${uid()}.webm`;
const mp4Pathname = `assets/episode-${id}.mp4`;
const source = `/tmp/podcast-video-${id}.webm`;
const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
try {
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0x10212b:s=640x360:r=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '2', '-c:v', 'libvpx-vp9', '-c:a', 'libopus', source], { stdio: 'ignore' });
  await put(pathname, await readFile(source), { access: 'private', addRandomSuffix: false });
  await initStore();
  await addEpisode({ id, ownerId: `video_check_${Date.now()}`, createdAt: stamp(), status: 'complete', outline: { subject: 'MP4 workflow check' }, settings: { outputFormat: 'both' }, turns: [], events: [], video: `/assets/${pathname.slice(7)}` });
  await podcastVideoWorkflow(id, pathname);
  const final = await episode(id);
  const output = await head(mp4Pathname);
  if (final.videoStatus !== 'complete' || final.mp4 !== `/assets/episode-${id}.mp4` || output.size < 1000) throw new Error(`Podcast MP4 workflow failed: ${final.videoError || final.videoStatus}`);
  console.log(`podcast MP4 workflow verified: ${output.size} bytes`);
} finally {
  await sql`DELETE FROM podcast_episodes WHERE id = ${id}`.catch(() => {});
  await del([pathname, mp4Pathname]).catch(() => {});
}
