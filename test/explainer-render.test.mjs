import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localSandboxClass } from './support/local-sandbox.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const temp = await mkdtemp(path.join(os.tmpdir(), 'explainer-render-'));
process.chdir(temp);
const sandboxRoot = path.join(temp, 'sandbox');
const LocalSandbox = localSandboxClass(sandboxRoot);
mock.module('../lib/vercel-sandbox.mjs', { namedExports: { VercelEpisodeSandbox: LocalSandbox, tools: new Set() } });
const store = await import('../lib/store.mjs');
const providers = await import('../lib/providers.mjs');
const { finishExplainer, rerenderExplainer } = await import('../workflows/explainer-steps.mjs');
await store.initStore();

const run = args => { const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]); assert.equal(result.status, 0, String(result.stderr)); };
const probe = file => JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_chapters', '-show_entries', 'format=duration', '-of', 'json', file], { encoding: 'utf8' }).stdout);

test('explainer mix adds brand cards, chapters, loudness, and re-renders edited narration from saved scenes', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  providers.registerSpeech('gateway', { voices: ['coral'], async synthesize(text) { return spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=500:duration=${Math.min(6, 1 + text.split(' ').length * 0.25)}`, '-f', 'mp3', 'pipe:1'], { maxBuffer: 8e6 }).stdout; } });
  const timeline = [];
  for (let index = 0; index < 3; index++) {
    const video = `/tmp/scene-${index}.mp4`, audio = `/tmp/scene-${index}.m4a`;
    run(['-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=30:d=12`, '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(sandboxRoot, `scene-${index}.mp4`)]);
    run(['-f', 'lavfi', '-i', `sine=frequency=${400 + index * 90}:duration=12`, '-c:a', 'aac', path.join(sandboxRoot, `scene-${index}.m4a`)]);
    const sceneAsset = await store.putNamedAsset(`scene-${index}.mp4`, await readFile(path.join(sandboxRoot, `scene-${index}.mp4`)));
    timeline.push({ text: `Scene ${index + 1} shows the dashboard panel and explains what the numbers mean for the team.`, title: `Step ${index + 1}`, duration: 12, captionDuration: 11, video, audio, sceneAsset, action: { type: 'click', selector: `@e${index}` }, screenChanged: true, metrics: { uniqueFrames: 60 } });
  }
  const item = { id: store.uid(), ownerId: 'owner', status: 'running', title: 'Dashboard tour', url: 'https://example.com', brief: 'Tour the dashboard', voice: 'coral', captionStyle: 'studio', captionOptions: { enabled: true }, branding: { intro: true, outro: true }, brand: { name: 'Acme', callToAction: 'Start a free trial', primaryColor: '#123456' } };
  await store.saveExplainer(item);
  await finishExplainer(item.id, timeline);
  let saved = await store.explainer(item.id);
  assert.equal(saved.status, 'complete');
  assert.deepEqual(saved.chapters.map(chapter => [chapter.start, chapter.title]), [[0, 'Step 1'], [15.5, 'Step 2'], [27.5, 'Step 3']]);
  assert.equal(saved.scenes.length, 3);
  const first = probe(path.join(temp, 'data/assets', saved.video.split('/').pop()));
  assert.equal(first.chapters.length, 3);
  assert.ok(Number(first.format.duration) > 36 + 3.5 + 4 - 0.5);
  const srt = await readFile(path.join(temp, 'data/assets', saved.captions.split('/').pop()), 'utf8');
  assert.match(srt, /^1\n00:00:03,500 --> /);

  saved.scenes[1].text = 'A much shorter line.';
  await store.saveExplainer({ ...saved, status: 'rendering' });
  await rerenderExplainer(item.id);
  saved = await store.explainer(item.id);
  assert.equal(saved.status, 'complete');
  assert.equal(saved.renderVersion, 1);
  assert.match(saved.video, /-v1\.mp4$/);
  assert.equal(saved.transcript[1], 'A much shorter line.');
  const second = probe(path.join(temp, 'data/assets', saved.video.split('/').pop()));
  assert.ok(Number(second.format.duration) < Number(first.format.duration), 'shorter narration shortens the video');
});
