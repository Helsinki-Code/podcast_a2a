import { explainer, setExplainerFields, putNamedAsset, refundCredits, stamp } from '../lib/store.mjs';
import { modelProviders, speechProviders, supportedVoice } from '../lib/providers.mjs';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';

const safeName = value => String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
const srtText = text => String(text).replace(/\r?\n/g, ' ').replace(/<[^>]+>/g, '');
export function explainerCaptionFilter(style = 'studio', subtitlePath = '/tmp/captions.srt') {
  const styles = {
    studio: 'FontName=DejaVu Sans,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H70000000,BackColour=&H70000000,BorderStyle=3,Outline=1,Shadow=0,Alignment=2,MarginV=52',
    minimal: 'FontName=DejaVu Sans,FontSize=19,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BackColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=50',
    editorial: 'FontName=DejaVu Serif,FontSize=17,PrimaryColour=&H00FFFFFF,OutlineColour=&H85000000,BackColour=&H85000000,BorderStyle=3,Outline=1,Shadow=0,Alignment=2,MarginV=58',
    bold: 'FontName=DejaVu Sans,FontSize=23,Bold=1,PrimaryColour=&H0019E6FF,OutlineColour=&H00101010,BackColour=&H40000000,BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=48'
  };
  return `subtitles=${subtitlePath}:force_style='${styles[style] || styles.studio}'`;
}
function srtTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const hours = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const minutes = String(Math.floor(ms % 3600000 / 60000)).padStart(2, '0');
  const secs = String(Math.floor(ms % 60000 / 1000)).padStart(2, '0');
  return `${hours}:${minutes}:${secs},${String(ms % 1000).padStart(3, '0')}`;
}

export function captionChunks(text, maxWords = 7, maxCharacters = 52) {
  const words = srtText(text).trim().split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = [];
  for (const word of words) {
    const candidate = [...current, word];
    if (current.length && (candidate.length > maxWords || candidate.join(' ').length > maxCharacters)) {
      chunks.push(current.join(' '));
      current = [word];
    } else current = candidate;
  }
  if (current.length) chunks.push(current.join(' '));
  return chunks;
}

export function buildCaptions(timeline) {
  let cursor = 0;
  let cue = 1;
  const entries = [];
  for (const part of timeline) {
    const chunks = captionChunks(part.text);
    const weights = chunks.map(chunk => chunk.split(/\s+/).length);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
    let sceneCursor = cursor;
    chunks.forEach((chunk, index) => {
      const end = index === chunks.length - 1 ? cursor + part.duration : sceneCursor + part.duration * weights[index] / totalWeight;
      entries.push(`${cue++}\n${srtTime(sceneCursor)} --> ${srtTime(end)}\n${chunk}\n`);
      sceneCursor = end;
    });
    cursor += part.duration;
  }
  return entries.join('\n');
}

export async function normalizeSceneVideo(browser, inputPath, outputPath, duration) {
  const length = String(Math.max(2, Math.min(40, Number(duration) || 8)));
  const videoFilter = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=30';
  let result = await browser.run('ffmpeg', ['-y', '-fflags', '+genpts', '-i', inputPath, '-t', length, '-an', '-vf', videoFilter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath], 10 * 60 * 1000);
  if (!result.exitCode) return { path: outputPath, usedScreenshotFallback: false };
  const recordingError = (await result.stderr()).slice(-1200);
  result = await browser.run('ffmpeg', ['-y', '-loop', '1', '-framerate', '30', '-i', '/tmp/podcast-browser.png', '-t', length, '-an', '-vf', videoFilter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath], 10 * 60 * 1000);
  if (result.exitCode) throw new Error(`Browser recording and screenshot fallback both failed. Recording: ${recordingError} Fallback: ${(await result.stderr()).slice(-1200)}`);
  return { path: outputPath, usedScreenshotFallback: true };
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

export async function explainerSceneBudget(id) {
  'use step';
  const item = await explainer(id);
  const words = String(item.brief || '').trim().split(/\s+/).filter(Boolean).length;
  const explicitSteps = (String(item.brief || '').match(/(?:^|\n)\s*(?:\d+[.)]|[-*])\s+/g) || []).length;
  return Math.max(4, Math.min(20, explicitSteps ? explicitSteps + 3 : Math.ceil(words / 14) + 4));
}

export async function planScene(id, screen, completed, index, finalAllowedScene = false) {
  'use step';
  const item = await explainer(id);
  await setExplainerFields(id, { progress: `Directing scene ${index + 1}` });
  const provider = modelProviders.get('gateway');
  const system = `You direct premium product explainer videos. Return one JSON object with narration, action, and done. The action is one of: {"type":"click","selector":"@e1"}, {"type":"type","selector":"@e1","value":"visible demo value"}, {"type":"select","selector":"@e1","value":"option value"}, {"type":"press","selector":"@e1","key":"ArrowRight"}, {"type":"scroll","direction":"down","amount":650}, {"type":"visit","url":"https://..."}, or {"type":"wait","ms":800}. Use only element refs visible in the supplied accessibility snapshot. Prefer one visible, reversible interaction in every scene; use wait only for the opening or when there is no safe interaction. Use type rather than fill so the viewer sees text being entered. Keep narration between 15 and 32 words and describe only what is visible now or what the action in this scene will visibly demonstrate. Never repeat instructions or claim an action succeeded before the resulting screen proves it. Move through the requested workflow in a coherent order. Stay read-only: never delete, submit payments, change settings, log out, or send messages. Set done true once the requested workflow has been covered. Do not mention automation, selectors, credentials, or that you are an AI.`;
  const context = `Application: ${item.url}\nRequested coverage: ${item.brief}\nScene: ${index + 1}${finalAllowedScene ? '\nThis is the final safe scene budget. Cover the most important remaining visible point and set done true.' : ''}\nAlready narrated:\n${completed.join('\n')}\nCurrent page: ${screen.title}\nAccessibility snapshot:\n${screen.content}`;
  return provider.generate([{ role: 'system', content: system }, { role: 'user', content: context }], process.env.EXPLAINER_MODEL || process.env.AI_GATEWAY_MODEL);
}

export async function renderScene(id, index, narration, action) {
  'use step';
  const item = await explainer(id);
  await setExplainerFields(id, { progress: `Recording scene ${index + 1}` });
  const browser = new VercelEpisodeSandbox(id, () => {});
  const speechProvider = item.speechProvider || 'gateway';
  const speech = speechProviders.get(speechProvider);
  if (!speech) throw new Error('The narration voice provider is unavailable.');
  const generated = await speech.synthesize(narration, supportedVoice(speechProvider, item.voice, 'coral'));
  const chunks = [];
  for await (const chunk of Buffer.isBuffer(generated) || generated instanceof Uint8Array ? [generated] : generated) chunks.push(Buffer.from(chunk));
  const audioPath = `/tmp/explainer-${index}.mp3`;
  const rawVideoPath = `/tmp/explainer-${index}.webm`;
  const videoPath = `/tmp/explainer-${index}.mp4`;
  await browser.writeSandboxFile(audioPath, Buffer.concat(chunks));
  const probe = await browser.run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath]);
  const duration = Math.max(2, Math.min(40, Number((await probe.stdout()).trim()) || 8));
  await browser.startVideo(rawVideoPath);
  try {
    await browser.command(['wait', '900']);
    await browser.performBrowserAction(action);
    await browser.command(['wait', String(Math.ceil(Math.max(900, duration * 1000 - 450)))]);
  } finally {
    await browser.stopVideo().catch(() => {});
  }
  const screen = await browser.capture(null, item.url);
  const normalized = await normalizeSceneVideo(browser, rawVideoPath, videoPath, duration);
  return { duration, video: normalized.path, audio: audioPath, screen, usedScreenshotFallback: normalized.usedScreenshotFallback };
}

export async function finishExplainer(id, timeline) {
  'use step';
  const item = await explainer(id);
  await setExplainerFields(id, { progress: 'Mixing narration, picture, and subtitles' });
  const browser = new VercelEpisodeSandbox(id, () => {});
  const videoList = timeline.map(part => `file '${part.video}'`).join('\n');
  const audioList = timeline.map(part => `file '${part.audio}'`).join('\n');
  const captions = buildCaptions(timeline);
  await browser.writeSandboxFile('/tmp/videos.txt', videoList);
  await browser.writeSandboxFile('/tmp/audio.txt', audioList);
  await browser.writeSandboxFile('/tmp/captions.srt', captions);
  let result = await browser.run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', '/tmp/videos.txt', '-c', 'copy', '-movflags', '+faststart', '/tmp/picture.mp4'], 10 * 60 * 1000);
  if (result.exitCode) {
    result = await browser.run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', '/tmp/videos.txt', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '/tmp/picture.mp4'], 10 * 60 * 1000);
  }
  if (result.exitCode) throw new Error(`Could not assemble browser recording: ${(await result.stderr()).slice(-1200)}`);
  result = await browser.run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', '/tmp/audio.txt', '-c:a', 'aac', '-b:a', '192k', '/tmp/narration.m4a'], 10 * 60 * 1000);
  if (result.exitCode) throw new Error(`Could not assemble narration: ${(await result.stderr()).slice(-1200)}`);
  result = await browser.run('ffmpeg', ['-y', '-i', '/tmp/picture.mp4', '-i', '/tmp/narration.m4a', '-vf', explainerCaptionFilter(item.captionStyle), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', '/tmp/final.mp4'], 15 * 60 * 1000);
  if (result.exitCode) {
    result = await browser.run('ffmpeg', ['-y', '-i', '/tmp/picture.mp4', '-i', '/tmp/narration.m4a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', '/tmp/final.mp4'], 15 * 60 * 1000);
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
