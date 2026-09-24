import { explainer, setExplainerFields, putNamedAsset, refundCredits, stamp } from '../lib/store.mjs';
import { modelProviders, speechProviders } from '../lib/providers.mjs';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';

const safeName = value => String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
const srtText = text => String(text).replace(/\r?\n/g, ' ').replace(/<[^>]+>/g, '');
function srtTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const hours = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const minutes = String(Math.floor(ms % 3600000 / 60000)).padStart(2, '0');
  const secs = String(Math.floor(ms % 60000 / 1000)).padStart(2, '0');
  return `${hours}:${minutes}:${secs},${String(ms % 1000).padStart(3, '0')}`;
}

export async function beginExplainer(id) {
  'use step';
  const item = await explainer(id);
  await setExplainerFields(id, { status: 'running', startedAt: stamp(), progress: 'Opening the application', error: null });
  const browser = new VercelEpisodeSandbox(id, () => {});
  await browser.setViewport(1920, 1080);
  if (!item.authRequired) await browser.command(['open', item.url]);
  return browser.capture(null, item.url);
}

export async function planScene(id, screen, completed, index) {
  'use step';
  const item = await explainer(id);
  await setExplainerFields(id, { progress: `Directing scene ${index + 1} of 8` });
  const provider = modelProviders.get('gateway');
  const system = `You direct premium product explainer videos. Return one JSON object with narration, action, and done. The action is one of: {"type":"click","selector":"@e1"}, {"type":"scroll","direction":"down","amount":650}, {"type":"visit","url":"https://..."}, or {"type":"wait","ms":800}. Use only element refs or selectors visible in the supplied accessibility snapshot. Explain what a prospective customer needs to understand. Keep narration between 35 and 75 words. Move through the real product in a coherent order. Stay read-only: never delete, submit payments, change settings, log out, or send messages. Set done true once the requested workflow has been covered. Do not mention automation, selectors, credentials, or that you are an AI.`;
  const context = `Application: ${item.url}\nRequested coverage: ${item.brief}\nScene: ${index + 1}\nAlready narrated:\n${completed.join('\n')}\nCurrent page: ${screen.title}\nAccessibility snapshot:\n${screen.content}`;
  return provider.generate([{ role: 'system', content: system }, { role: 'user', content: context }], process.env.EXPLAINER_MODEL || process.env.AI_GATEWAY_MODEL);
}

export async function renderScene(id, index, narration, action) {
  'use step';
  const item = await explainer(id);
  await setExplainerFields(id, { progress: `Recording scene ${index + 1}` });
  const browser = new VercelEpisodeSandbox(id, () => {});
  const speech = speechProviders.get(item.speechProvider || 'gateway');
  if (!speech) throw new Error('The narration voice provider is unavailable.');
  const generated = await speech.synthesize(narration, item.voice || 'marin');
  const chunks = [];
  for await (const chunk of Buffer.isBuffer(generated) || generated instanceof Uint8Array ? [generated] : generated) chunks.push(Buffer.from(chunk));
  const audioPath = `/tmp/explainer-${index}.mp3`;
  const videoPath = `/tmp/explainer-${index}.webm`;
  await browser.writeSandboxFile(audioPath, Buffer.concat(chunks));
  const probe = await browser.run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath]);
  const duration = Math.max(2, Math.min(40, Number((await probe.stdout()).trim()) || 8));
  await browser.startVideo(videoPath);
  try {
    await browser.performBrowserAction(action);
    await browser.command(['wait', String(Math.ceil(duration * 1000 + 450))]);
  } finally {
    await browser.stopVideo().catch(() => {});
  }
  const screen = await browser.capture(null, item.url);
  return { duration, video: videoPath, audio: audioPath, screen };
}

export async function finishExplainer(id, timeline) {
  'use step';
  const item = await explainer(id);
  await setExplainerFields(id, { progress: 'Mixing narration, picture, and subtitles' });
  const browser = new VercelEpisodeSandbox(id, () => {});
  const videoList = timeline.map(part => `file '${part.video}'`).join('\n');
  const audioList = timeline.map(part => `file '${part.audio}'`).join('\n');
  let cursor = 0;
  const captions = timeline.map((part, index) => {
    const start = cursor; cursor += part.duration;
    return `${index + 1}\n${srtTime(start)} --> ${srtTime(cursor)}\n${srtText(part.text)}\n`;
  }).join('\n');
  await browser.writeSandboxFile('/tmp/videos.txt', videoList);
  await browser.writeSandboxFile('/tmp/audio.txt', audioList);
  await browser.writeSandboxFile('/tmp/captions.srt', captions);
  let result = await browser.run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', '/tmp/videos.txt', '-c', 'copy', '/tmp/picture.webm'], 10 * 60 * 1000);
  if (result.exitCode) throw new Error(`Could not assemble browser recording: ${(await result.stderr()).slice(-1200)}`);
  result = await browser.run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', '/tmp/audio.txt', '-c:a', 'aac', '-b:a', '192k', '/tmp/narration.m4a'], 10 * 60 * 1000);
  if (result.exitCode) throw new Error(`Could not assemble narration: ${(await result.stderr()).slice(-1200)}`);
  result = await browser.run('ffmpeg', ['-y', '-i', '/tmp/picture.webm', '-i', '/tmp/narration.m4a', '-vf', "subtitles=/tmp/captions.srt:force_style='FontName=DejaVu Sans,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=3,Outline=1,Shadow=0,MarginV=38'", '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', '/tmp/final.mp4'], 15 * 60 * 1000);
  if (result.exitCode) {
    result = await browser.run('ffmpeg', ['-y', '-i', '/tmp/picture.webm', '-i', '/tmp/narration.m4a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', '/tmp/final.mp4'], 15 * 60 * 1000);
  }
  if (result.exitCode) throw new Error(`Could not render the final video: ${(await result.stderr()).slice(-1200)}`);
  const [video, srt] = await Promise.all([browser.readSandboxFile('/tmp/final.mp4'), browser.readSandboxFile('/tmp/captions.srt')]);
  const stem = `explainer-${safeName(id)}`;
  const [videoUrl, captionsUrl] = await Promise.all([putNamedAsset(`${stem}.mp4`, video), putNamedAsset(`${stem}.srt`, srt)]);
  await setExplainerFields(id, { status: 'complete', progress: 'Complete', endedAt: stamp(), video: videoUrl, captions: captionsUrl, transcript: timeline.map(part => part.text) });
  await browser.close().catch(() => {});
}

export async function failExplainer(id, message) {
  'use step';
  const item = await explainer(id);
  if (item?.creditsCharged && item.ownerId) await refundCredits(item.ownerId, item.creditsCharged, 'explainer', id);
  await setExplainerFields(id, { status: 'failed', progress: 'Failed', endedAt: stamp(), error: String(message).slice(0, 2000) });
  await new VercelEpisodeSandbox(id, () => {}).close().catch(() => {});
}
