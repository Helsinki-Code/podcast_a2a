import { captureError } from '../lib/monitor.mjs';
import { enterUsage } from '../lib/usage.mjs';
import { episode, setEpisodeFields, putNamedAsset, readAssetBytes, refundCredits, stamp } from '../lib/store.mjs';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';
import { podcastTimeline, podcastCaptions, podcastCaptionFilter } from '../lib/podcast-timeline.mjs';
import { inspectSandboxMedia, evaluateMediaQuality } from '../lib/media-quality.mjs';
import { stageHtml, titleCardHtml, generatedMusicSource, titleMusicFilter, finalAudioGraph, SPEECH_TRIM_FILTER, interruptionFadeFilter, INTRO_SECONDS, OUTRO_SECONDS } from '../lib/podcast-media.mjs';
import { castRoles, roleAccent } from '../lib/cast.mjs';
import { packageVideo } from '../lib/publish-media.mjs';
import { podcastExportTimeline } from '../lib/publishing.mjs';

const safe = value => String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_');
const extension = reference => /\.webp$/i.test(reference) ? 'webp' : /\.jpe?g$/i.test(reference) ? 'jpg' : 'png';
const imageData = (bytes, reference) => bytes?.length ? `data:image/${extension(reference) === 'jpg' ? 'jpeg' : extension(reference)};base64,${bytes.toString('base64')}` : '';

export function podcastOutputSpec(settings = {}) {
  const fullHD = !(Number(settings.width) === 1280 && Number(settings.height) === 720);
  return { width: fullHD ? 1920 : 1280, height: fullHD ? 1080 : 720, format: ['mp4', 'webm', 'both'].includes(settings.outputFormat) ? settings.outputFormat : 'both' };
}

async function optionalAsset(reference) {
  if (!reference) return null;
  try { return await readAssetBytes(reference); } catch { return null; }
}

async function probeDuration(browser, filename) {
  const result = await browser.run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filename], 30000);
  if (result.exitCode) throw new Error(`Could not read ${filename}: ${(await result.stderr()).slice(-800)}`);
  const duration = Number((await result.stdout()).trim());
  if (!(duration > 0)) throw new Error(`${filename} has no valid duration.`);
  return duration;
}

async function renderStage(browser, filename, markup) {
  const htmlPath = filename.replace(/\.png$/, '.html');
  await browser.writeSandboxFile(htmlPath, markup);
  await browser.setViewport(1920, 1080);
  await browser.command(['open', `file://${htmlPath}`]);
  await browser.command(['wait', '250']);
  const result = await browser.command(['screenshot', filename]);
  if (result?.exitCode) throw new Error(`Could not capture the podcast stage: ${String(result.stderr || '').slice(-800)}`);
}

export async function renderPodcastTimeline(episodeId) {
  'use step';
  const item = await episode(episodeId);
  enterUsage({ ownerId: item?.ownerId, kind: 'podcast', id: episodeId });
  if (!item) throw new Error('Podcast not found.');
  await setEpisodeFields(episodeId, { videoStatus: 'processing', videoError: null });
  const sourceTimeline = podcastTimeline(item.events || [], { gap: 0 });
  const speechCount = sourceTimeline.filter(entry => entry.type === 'speech').length;
  const browserCount = sourceTimeline.filter(entry => entry.video).length;
  if (speechCount < 2) throw new Error('The podcast has too little completed speech to render.');
  if (item.settings?.requireGuestDemo && browserCount < 1) throw new Error('The required guest Computer Use demonstration is missing from the podcast timeline.');
  const browser = new VercelEpisodeSandbox(`render-${episodeId}`, () => {});
  try {
    const fields = await assemblePodcast(browser, item, sourceTimeline, { stem: `episode-${safe(episodeId)}` });
    await setEpisodeFields(episodeId, { ...fields, videoStatus: 'complete', renderedAt: stamp() });
    return fields.mp4;
  } finally {
    await browser.close().catch(() => {});
  }
}

// Builds the finished programme from a speech timeline. `variant` renders (dubbed languages) skip
// the WebM copy and the publishing package.
export async function assemblePodcast(browser, item, sourceTimeline, { stem, variant = false }) {
  const settings = item.settings || {};
  const music = settings.music || {};
  const roles = castRoles(item);
  const roleBytes = await Promise.all(roles.map(role => optionalAsset(item.personas?.[role]?.image)));
  const logoBytes = await optionalAsset(item.brand?.logo);
  const images = { logo: imageData(logoBytes, item.brand?.logo), roles: Object.fromEntries(roles.map((role, i) => [role, imageData(roleBytes[i], item.personas?.[role]?.image)])) };
  const musicTrack = music.track ? await optionalAsset(music.track) : null;
  if (musicTrack?.length) await browser.writeSandboxFile('/tmp/podcast-music-source', musicTrack);
  const musicInput = seconds => musicTrack?.length ? ['-stream_loop', '-1', '-i', '/tmp/podcast-music-source'] : ['-f', 'lavfi', '-i', generatedMusicSource(seconds)];
  const parts = [];
  const timed = [];
  let cursor = 0;
  // Title cards (intro/outro) are still frames with music under them.
  const titleCard = async (kind, seconds) => {
    const stagePath = `/tmp/podcast-${kind}.png`, segmentPath = `/tmp/podcast-${kind}.mp4`;
    await renderStage(browser, stagePath, titleCardHtml(item, images, kind));
    const result = await browser.run('ffmpeg', ['-y', '-loop', '1', '-framerate', '30', '-i', stagePath, ...musicInput(seconds), '-t', seconds.toFixed(2), '-filter_complex', `[0:v]scale=1920:1080,fps=30,format=yuv420p,fade=t=in:d=0.5,fade=t=out:st=${(seconds - 0.6).toFixed(2)}:d=0.6[v];[1:a]${titleMusicFilter(seconds)}[a]`, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', segmentPath], 5 * 60 * 1000);
    if (result.exitCode) throw new Error(`Could not render the ${kind} card: ${(await result.stderr()).slice(-1200)}`);
    parts.push(segmentPath);
    cursor += seconds;
  };
  if (music.intro) await titleCard('intro', INTRO_SECONDS);
  const conversationStart = cursor;
  for (let index = 0; index < sourceTimeline.length; index++) {
    const entry = sourceTimeline[index];
    if (entry.type === 'speech') {
      const [audioBytes, screenBytes, actionBytes] = await Promise.all([readAssetBytes(entry.audio), optionalAsset(entry.screen), optionalAsset(entry.video)]);
      const audioPath = `/tmp/podcast-speech-${index}.mp3`;
      let trimmedAudioPath = `/tmp/podcast-speech-${index}.wav`;
      const stagePath = `/tmp/podcast-stage-${index}.png`;
      const segmentPath = `/tmp/podcast-part-${index}.mp4`;
      await browser.writeSandboxFile(audioPath, audioBytes);
      let result = await browser.run('ffmpeg', ['-y', '-i', audioPath, '-af', SPEECH_TRIM_FILTER, '-ar', '48000', '-ac', '2', trimmedAudioPath], 120000);
      if (result.exitCode) throw new Error(`Could not remove speech boundary silence ${index + 1}: ${(await result.stderr()).slice(-1200)}`);
      const audioDuration = await probeDuration(browser, trimmedAudioPath);
      const fade = entry.interrupted ? interruptionFadeFilter(audioDuration) : '';
      if (fade) {
        const fadedPath = `/tmp/podcast-speech-${index}-cut.wav`;
        result = await browser.run('ffmpeg', ['-y', '-i', trimmedAudioPath, '-af', fade, fadedPath], 120000);
        if (!result.exitCode) trimmedAudioPath = fadedPath;
      }
      const duration = audioDuration + entry.gap;
      await renderStage(browser, stagePath, stageHtml(item, entry, images, imageData(screenBytes, entry.screen)));
      if (actionBytes?.length) {
        const actionPath = `/tmp/podcast-action-${index}.mp4`;
        await browser.writeSandboxFile(actionPath, actionBytes);
        const actionDuration = await probeDuration(browser, actionPath);
        const speed = duration / actionDuration;
        result = await browser.run('ffmpeg', ['-y', '-loop', '1', '-framerate', '30', '-i', stagePath, '-i', actionPath, '-i', trimmedAudioPath, '-t', String(duration), '-filter_complex', `[0:v]scale=1920:1080,fps=30,format=yuv420p[stage];[1:v]setpts=${speed.toFixed(6)}*PTS,scale=1060:644:force_original_aspect_ratio=decrease,pad=1060:644:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,format=yuv420p[action];[stage][action]overlay=772:213:shortest=1[outv]`, '-map', '[outv]', '-map', '2:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-shortest', '-movflags', '+faststart', segmentPath], 10 * 60 * 1000);
      } else {
        result = await browser.run('ffmpeg', ['-y', '-loop', '1', '-framerate', '30', '-i', stagePath, '-i', trimmedAudioPath, '-t', String(duration), '-vf', 'scale=1920:1080,fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-shortest', '-movflags', '+faststart', segmentPath], 10 * 60 * 1000);
      }
      if (result.exitCode) throw new Error(`Could not render podcast speech ${index + 1}: ${(await result.stderr()).slice(-1200)}`);
      parts.push(segmentPath);
      timed.push({ ...entry, start: cursor, duration, audioDuration });
      cursor += duration;
    }
  }
  const conversationDuration = cursor - conversationStart;
  if (music.outro) await titleCard('outro', OUTRO_SECONDS);
  await browser.writeSandboxFile('/tmp/podcast-parts.txt', parts.map(filename => `file '${filename}'`).join('\n'));
  const captionsEnabled = settings.captionsEnabled !== false;
  const labelColors = Object.fromEntries(roles.map(role => [role, roleAccent(settings, role)]));
  await browser.writeSandboxFile('/tmp/podcast.srt', podcastCaptions(timed, { speakerLabels: true }));
  if (captionsEnabled) await browser.writeSandboxFile('/tmp/podcast-burn.srt', podcastCaptions(timed, { speakerLabels: true, labelColors }));
  let result = await browser.run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', '/tmp/podcast-parts.txt', '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '/tmp/podcast-base.mp4'], 20 * 60 * 1000);
  if (result.exitCode) throw new Error(`Could not assemble the podcast timeline: ${(await result.stderr()).slice(-1200)}`);
  const { width, height, format } = podcastOutputSpec(settings);
  const finalFilters = [...(captionsEnabled ? [podcastCaptionFilter(settings.captionStyle)] : []), ...(width !== 1920 ? [`scale=${width}:${height}:flags=lanczos`] : [])];
  // Final pass: burned captions + output scale on the picture; music bed + loudness on the sound.
  const bed = Boolean(music.bed) && conversationDuration > 0;
  const audioGraph = finalAudioGraph({ bed, volume: music.volume, bedStart: conversationStart, bedDuration: conversationDuration });
  const videoGraph = finalFilters.length ? `[0:v]${finalFilters.join(',')}[vout]` : '[0:v]null[vout]';
  const finalArgs = ['-y', '-i', '/tmp/podcast-base.mp4', ...(bed ? musicInput(conversationDuration + 1) : []), '-filter_complex', `${videoGraph};${audioGraph}`, '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '/tmp/podcast-final.mp4'];
  result = await browser.run('ffmpeg', finalArgs, 20 * 60 * 1000);
  if (result.exitCode) throw new Error(`Could not mix the final podcast: ${(await result.stderr()).slice(-1200)}`);
  const quality = await inspectSandboxMedia(browser, '/tmp/podcast-final.mp4', { sceneThreshold: 0.008, silenceNoise: '-30dB', silenceDuration: .25 });
  const verdict = evaluateMediaQuality(quality, { interactive: Boolean(item.settings?.requireGuestDemo), minDuration: 4, maxSilencePercent: 15, maxSilenceSeconds: 1 });
  if (!verdict.passed) throw new Error(`Podcast quality check failed: ${verdict.failures.join(' ')}`);
  const exportTimeline = podcastExportTimeline(item, timed);
  const packaged = variant ? null : await packageVideo(browser, { kind: 'podcast', item, finalPath: '/tmp/podcast-final.mp4', timeline: exportTimeline, totalDuration: cursor, stem, accent: roleAccent(settings, 'host') });
  let webm = null, webmError = null;
  if (format !== 'mp4' && !variant) {
    // VP9 in realtime mode keeps the WebM pass short; the MP4 stays the quality-checked master.
    const encoded = await browser.run('ffmpeg', ['-y', '-i', '/tmp/podcast-final.mp4', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-b:v', '0', '-crf', '32', '-c:a', 'libopus', '-b:a', '128k', '/tmp/podcast-final.webm'], 20 * 60 * 1000);
    if (encoded.exitCode) webmError = `WebM export failed: ${(await encoded.stderr()).slice(-600)}`;
    else webm = await putNamedAsset(`${stem}.webm`, await browser.readSandboxFile('/tmp/podcast-final.webm'));
  }
  const [video, captions] = await Promise.all([browser.readSandboxFile(packaged?.finalPath || '/tmp/podcast-final.mp4'), browser.readSandboxFile('/tmp/podcast.srt')]);
  const [mp4, captionUrl] = await Promise.all([putNamedAsset(`${stem}.mp4`, video), putNamedAsset(`${stem}.srt`, captions)]);
  // A WebM-only request still keeps the MP4 when the WebM encode fails, rather than delivering nothing.
  return { mp4, ...(webm ? { video: webm } : {}), captions: captionUrl, videoError: webmError, quality, output: { width, height, format }, timeline: exportTimeline, duration: cursor, ...(packaged ? { chapters: packaged.chapters, youtube: packaged.youtube, thumbnail: packaged.thumbnail, mp3: packaged.mp3 } : {}) };
}

// A render failure keeps the recorded conversation (so the MP4 can be retried) but refunds the charge,
// because no finished video was delivered.
export async function failPodcastRender(episodeId, message) {
  'use step';
  await captureError(new Error(message || 'Podcast rendering failed.'), { kind: 'podcast', id: episodeId, stage: 'render' });
  const item = await episode(episodeId);
  if (item?.creditsCharged && item.ownerId) await refundCredits(item.ownerId, item.creditsCharged, 'podcast', item.creditReference || episodeId);
  const reason = String(message || 'Podcast rendering failed.').slice(0, 2000);
  await setEpisodeFields(episodeId, { videoStatus: 'failed', videoError: reason, creditsCharged: 0, ...(item?.endedAt ? {} : { endedAt: stamp() }) });
}
