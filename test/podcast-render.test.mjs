import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localSandboxClass } from './support/local-sandbox.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const temp = await mkdtemp(path.join(os.tmpdir(), 'podcast-render-'));
process.chdir(temp);
const LocalSandbox = localSandboxClass(path.join(temp, 'sandbox'));
mock.module('../lib/vercel-sandbox.mjs', { namedExports: { VercelEpisodeSandbox: LocalSandbox, tools: new Set() } });
const store = await import('../lib/store.mjs');
const { renderPodcastTimeline } = await import('../workflows/podcast-render-steps.mjs');
await store.initStore();

function tone(frequency, seconds) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}`, '-f', 'mp3', 'pipe:1'], { maxBuffer: 8 * 1024 * 1024 });
  return result.stdout;
}
function probe(file) {
  return JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', file], { encoding: 'utf8' }).stdout);
}

test('podcast render assembles a panel episode with cards, captions, music bed, and loudness', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const audio = [];
  for (const [index, frequency] of [440, 520, 610, 700].entries()) {
    const id = store.uid();
    await store.putNamedAsset(`${id}.mp3`, tone(frequency, 2 + index * 0.3));
    audio.push(`/api/audio/${id}`);
  }
  const item = {
    id: store.uid(), ownerId: 'owner', status: 'complete', turns: [], outline: { subject: 'Render test' },
    personas: { host: { name: 'Hana' }, cohost: { name: 'Cole' }, guest: { name: 'Gus' }, guest2: { name: 'Gia' } },
    settings: { width: 1280, height: 720, outputFormat: 'both', captionStyle: 'studio', music: { intro: true, outro: true, bed: true, volume: 0.08 } },
    events: [
      { id: 'a', type: 'speech', role: 'host', text: 'Welcome to the show, everyone. Gus, what do you build?', audio: audio[0] },
      { id: 'b', type: 'speech', role: 'guest', text: 'We build a planning tool that keeps sales teams focused on the right accounts every week.', audio: audio[1] },
      { id: 'i', type: 'interrupt', by: 'guest2', reason: 'addressed' },
      { id: 'c', type: 'speech', role: 'guest2', text: 'And I would add that the weekly review is where it really pays off.', audio: audio[2] },
      { id: 'd', type: 'speech', role: 'cohost', text: 'Great point. Thanks both, that is a wrap for today.', audio: audio[3] }
    ]
  };
  await store.addEpisode(item);
  await renderPodcastTimeline(item.id);
  const saved = await store.episode(item.id);
  assert.equal(saved.videoStatus, 'complete', saved.videoError);
  assert.deepEqual(saved.output, { width: 1280, height: 720, format: 'both' });
  const mp4 = probe(path.join(temp, 'data/assets', saved.mp4.split('/').pop()));
  const video = mp4.streams.find(stream => stream.codec_type === 'video');
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.ok(Number(mp4.format.duration) > 4.5 * 2 + 8, `duration ${mp4.format.duration}`);
  assert.ok(saved.video?.endsWith('.webm'));
  const srt = await readFile(path.join(temp, 'data/assets', saved.captions.split('/').pop()), 'utf8');
  assert.match(srt, /^1\n00:00:04,500 --> /, 'captions start after the intro card');
  assert.match(srt, /CO-HOST: Great point/);
  assert.match(srt, /GUEST 2: And I would add/);
});
