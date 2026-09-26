import { setExplainerFields, putNamedAsset, readAssetBytes } from './store.mjs';
import { speechProviders, supportedVoice } from './providers.mjs';
import { inspectSandboxMedia, evaluateMediaQuality } from './media-quality.mjs';
import { ffmetadata, normalizeChapters, titleFromText } from './chapters.mjs';
import { generatedMusicSource, titleMusicFilter } from './podcast-media.mjs';
import { generateMetadata, packageVideo } from './publish-media.mjs';
import { buildCaptions, explainerCaptionFilter } from '../workflows/explainer-steps.mjs';

// Plain explainer assembly shared by the first render, re-renders, and dubbing. Kept out of the
// step file so the workflow bundle, which imports that file, never pulls in the store.
const safeName = value => String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
const validHex = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;
async function supportsBurnedCaptions(browser) {
  const result = await browser.run('ffmpeg', ['-hide_banner', '-filters'], 30000);
  return /\bsubtitles\b/.test(`${await result.stdout()}\n${await result.stderr()}`);
}

// Brand title card for the start or end of an explainer: a still frame with a short music sting.
async function explainerCard(browser, item, kind, seconds) {
  const brand = item.brand || {};
  const logo = brand.logo ? await readAssetBytes(brand.logo).catch(() => null) : null;
  const logoData = logo?.length ? `data:image/${/\.svg$/i.test(brand.logo) ? 'svg+xml' : /\.jpe?g$/i.test(brand.logo) ? 'jpeg' : /\.webp$/i.test(brand.logo) ? 'webp' : 'png'};base64,${logo.toString('base64')}` : '';
  const primary = validHex(brand.primaryColor, '#101c24'), accent = validHex(brand.accentColor, '#80ded1');
  const escape = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const heading = kind === 'intro' ? escape(item.title) : escape(brand.outroText || 'Thanks for watching');
  const line = kind === 'intro' ? escape(brand.name || '') : escape(brand.callToAction || '');
  const markup = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:1920px;height:1080px;background:${primary};color:#fff;font-family:Arial,sans-serif;display:grid;place-items:center;text-align:center}img{max-height:150px;max-width:520px;margin-bottom:48px}h1{font-size:84px;margin:0 160px 28px;line-height:1.05}p{font-size:34px;color:${accent};margin:0;letter-spacing:2px}</style><div>${logoData ? `<img src="${logoData}">` : ''}<h1>${heading}</h1><p>${line}</p></div>`;
  const htmlPath = `/tmp/explainer-${kind}.html`, pngPath = `/tmp/explainer-${kind}.png`;
  await browser.writeSandboxFile(htmlPath, markup);
  await browser.command(['open', `file://${htmlPath}`]);
  await browser.command(['wait', '250']);
  await browser.command(['screenshot', pngPath]);
  const videoPath = `/tmp/explainer-${kind}.mp4`, audioPath = `/tmp/explainer-${kind}.m4a`;
  let result = await browser.run('ffmpeg', ['-y', '-loop', '1', '-framerate', '30', '-i', pngPath, '-t', seconds.toFixed(2), '-vf', `scale=1920:1080,fps=30,format=yuv420p,fade=t=in:d=0.4,fade=t=out:st=${(seconds - 0.5).toFixed(2)}:d=0.5`, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', videoPath], 5 * 60 * 1000);
  if (result.exitCode) throw new Error(`Could not render the ${kind} card: ${(await result.stderr()).slice(-800)}`);
  result = await browser.run('ffmpeg', ['-y', '-f', 'lavfi', '-i', generatedMusicSource(seconds), '-af', titleMusicFilter(seconds), '-c:a', 'aac', '-b:a', '192k', audioPath], 5 * 60 * 1000);
  if (result.exitCode) throw new Error(`Could not render the ${kind} sound: ${(await result.stderr()).slice(-800)}`);
  return { video: videoPath, audio: audioPath, duration: seconds };
}

// Shared by the first render and by re-renders: cards, captions, chapters, mix, quality check, upload.
export async function mixExplainer(browser, id, item, timeline, { variant = '' } = {}) {
  await setExplainerFields(id, { progress: 'Mixing narration, picture, and subtitles' });
  const branding = item.branding || {};
  const intro = branding.intro && item.brand ? await explainerCard(browser, item, 'intro', 3.5) : null;
  const outro = branding.outro && item.brand ? await explainerCard(browser, item, 'outro', 4) : null;
  const pieces = [...(intro ? [intro] : []), ...timeline, ...(outro ? [outro] : [])];
  const captionOptions = { style: item.captionStyle || 'studio', ...(item.captionOptions || {}), offset: intro?.duration || 0 };
  const captions = buildCaptions(timeline, captionOptions);
  const metadata = variant ? null : await generateMetadata('explainer', item, timeline.map(part => ({ text: part.text })));
  let cursor = intro?.duration || 0;
  const rawChapters = [];
  if (intro) rawChapters.push({ start: 0, title: 'Introduction' });
  timeline.forEach((part, index) => { rawChapters.push({ start: cursor, title: part.title || metadata?.chapterTitles?.[index] || titleFromText(part.text) }); cursor += part.duration; });
  const totalDuration = pieces.reduce((sum, part) => sum + part.duration, 0);
  const chapters = normalizeChapters(rawChapters, totalDuration);
  await browser.writeSandboxFile('/tmp/videos.txt', pieces.map(part => `file '${part.video}'`).join('\n'));
  await browser.writeSandboxFile('/tmp/audio.txt', pieces.map(part => `file '${part.audio}'`).join('\n'));
  await browser.writeSandboxFile('/tmp/captions.srt', captions);
  await browser.writeSandboxFile('/tmp/chapters.txt', ffmetadata(chapters, totalDuration, { title: item.title, comment: metadata?.description }));
  let result = await browser.run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', '/tmp/videos.txt', '-an', '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '/tmp/picture.mp4'], 10 * 60 * 1000);
  if (result.exitCode) throw new Error(`Could not assemble browser recording: ${(await result.stderr()).slice(-1200)}`);
  result = await browser.run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', '/tmp/audio.txt', '-c:a', 'aac', '-b:a', '192k', '/tmp/narration.m4a'], 10 * 60 * 1000);
  if (result.exitCode) throw new Error(`Could not assemble narration: ${(await result.stderr()).slice(-1200)}`);
  const burnCaptions = captionOptions.enabled !== false && await supportsBurnedCaptions(browser);
  const finalArgs = ['-y', '-i', '/tmp/picture.mp4', '-i', '/tmp/narration.m4a', '-i', '/tmp/chapters.txt', '-map', '0:v', '-map', '1:a', '-map_metadata', '2', '-map_chapters', '2', ...(burnCaptions ? ['-vf', explainerCaptionFilter(captionOptions)] : []), '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-shortest', '/tmp/final.mp4'];
  result = await browser.run('ffmpeg', finalArgs, 15 * 60 * 1000);
  if (result.exitCode) throw new Error(`Could not render the final video: ${(await result.stderr()).slice(-1200)}`);
  const quality = await inspectSandboxMedia(browser, '/tmp/final.mp4', { sceneThreshold: 0.008 });
  const interactiveActions = timeline.filter(part => !['wait'].includes(part.action?.type));
  quality.sceneChanges = interactiveActions.filter(part => part.screenChanged).length;
  quality.uniqueFrames = interactiveActions.reduce((sum, part) => sum + Number(part.metrics?.uniqueFrames || 0), 0);
  const verdict = evaluateMediaQuality(quality, { interactive: interactiveActions.length > 0, minDuration: Math.max(4, timeline.length * 1.5), maxSilencePercent: 35, maxSilenceSeconds: 2 });
  if (!verdict.passed) throw new Error(`Explainer quality check failed: ${verdict.failures.join(' ')}`);
  const stem = `explainer-${safeName(id)}${item.renderVersion ? `-v${item.renderVersion}` : ''}${variant ? `-${safeName(variant)}` : ''}`;
  let exportCursor = intro?.duration || 0;
  const exportTimeline = timeline.map(part => { const entry = { speaker: '', text: part.text, start: Number(exportCursor.toFixed(3)), duration: Number(Math.min(part.duration, Number(part.captionDuration) || part.duration).toFixed(3)) }; exportCursor += part.duration; return entry; });
  const packaged = variant ? {} : await packageVideo(browser, { kind: 'explainer', item, finalPath: '/tmp/final.mp4', timeline: exportTimeline, totalDuration, chapters, stem, accent: item.brand?.accentColor || '#80ded1', metadata });
  const [video, srt] = await Promise.all([browser.readSandboxFile('/tmp/final.mp4'), browser.readSandboxFile('/tmp/captions.srt')]);
  const [videoUrl, captionsUrl] = await Promise.all([putNamedAsset(`${stem}.mp4`, video), putNamedAsset(`${stem}.srt`, srt)]);
  return {
    video: videoUrl, captions: captionsUrl, captionsBurned: burnCaptions, quality, chapters, summary: metadata?.description?.split(/\n\s*\n/)[0] || '',
    timeline: exportTimeline, duration: totalDuration, youtube: packaged.youtube, thumbnail: packaged.thumbnail, mp3: packaged.mp3,
    transcript: timeline.map(part => part.text), actions: timeline.map(part => part.action),
    scenes: timeline.map((part, index) => ({ text: part.text, title: rawChapters[index + (intro ? 1 : 0)]?.title || '', video: part.sceneAsset, duration: part.duration, captionDuration: part.captionDuration, action: part.action, screenChanged: part.screenChanged, metrics: part.metrics })).filter(scene => scene.video)
  };
}

// Voices each saved scene with new text and retimes its clip to the new narration length.
export async function revoiceScenes(browser, item, texts = [], voice = item.voice) {
  const speechProvider = item.speechProvider || 'gateway';
  const speech = speechProviders.get(speechProvider);
  if (!speech) throw new Error('The narration voice provider is unavailable.');
  const timeline = [];
  for (const [index, scene] of item.scenes.entries()) {
    const text = String(texts[index] ?? scene.text);
    const generated = await speech.synthesize(text, supportedVoice(speechProvider, voice, 'coral'), { style: 'clear, friendly product walkthrough narrator' });
    const chunks = [];
    for await (const chunk of Buffer.isBuffer(generated) || generated instanceof Uint8Array ? [generated] : generated) chunks.push(Buffer.from(chunk));
    const audioPath = `/tmp/rerender-${index}.mp3`, sourcePath = `/tmp/rerender-source-${index}.mp4`, videoPath = `/tmp/rerender-${index}.mp4`, paddedPath = `/tmp/rerender-${index}.m4a`;
    await browser.writeSandboxFile(audioPath, Buffer.concat(chunks));
    await browser.writeSandboxFile(sourcePath, await readAssetBytes(scene.video));
    const probe = await browser.run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath]);
    const speechDuration = Math.max(2, Math.min(40, Number((await probe.stdout()).trim()) || 8));
    const ratio = Math.max(0.6, Math.min(1.6, speechDuration / Math.max(0.5, Number(scene.duration) || speechDuration)));
    let result = await browser.run('ffmpeg', ['-y', '-i', sourcePath, '-vf', `setpts=${ratio.toFixed(6)}*PTS,tpad=stop_mode=clone:stop_duration=40,fps=30,format=yuv420p`, '-t', speechDuration.toFixed(3), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', videoPath], 10 * 60 * 1000);
    if (result.exitCode) throw new Error(`Could not retime scene ${index + 1}: ${(await result.stderr()).slice(-800)}`);
    result = await browser.run('ffmpeg', ['-y', '-i', audioPath, '-af', 'apad', '-t', speechDuration.toFixed(3), '-c:a', 'aac', '-b:a', '192k', paddedPath], 5 * 60 * 1000);
    if (result.exitCode) throw new Error(`Could not align narration ${index + 1}: ${(await result.stderr()).slice(-800)}`);
    timeline.push({ ...scene, text, duration: speechDuration, captionDuration: speechDuration, video: videoPath, audio: paddedPath, sceneAsset: scene.video });
  }
  return timeline;
}
