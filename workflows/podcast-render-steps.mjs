import { episode, setEpisodeFields, putNamedAsset, readAssetBytes, refundCredits, stamp } from '../lib/store.mjs';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';
import { podcastTimeline, podcastCaptions } from '../lib/podcast-timeline.mjs';
import { inspectSandboxMedia, evaluateMediaQuality } from '../lib/media-quality.mjs';

const safe = value => String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_');
const extension = reference => /\.webp$/i.test(reference) ? 'webp' : /\.jpe?g$/i.test(reference) ? 'jpg' : 'png';
const html = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const imageData = (bytes, reference) => bytes?.length ? `data:image/${extension(reference) === 'jpg' ? 'jpeg' : extension(reference)};base64,${bytes.toString('base64')}` : '';

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

function stageHtml(item, entry, hostImage, guestImage, screenImage) {
  const settings = item.settings || {};
  const accent = /^#[0-9a-f]{6}$/i.test(settings.accent) ? settings.accent : '#80ded1';
  const guestAccent = /^#[0-9a-f]{6}$/i.test(settings.guestAccent) ? settings.guestAccent : '#efbe9e';
  const background = /^#[0-9a-f]{6}$/i.test(settings.background) ? settings.background : '#101c24';
  const avatar = (person, image, role, color) => `<section class="person ${entry.role === role ? 'active' : ''}" style="--color:${color}"><div class="avatar">${image ? `<img src="${image}">` : `<span>${html(person?.name?.[0] || '?')}</span>`}</div><strong>${html(person?.name || role)}</strong><small>${role.toUpperCase()}</small></section>`;
  return `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:${background};font-family:Arial,sans-serif;color:#f4faf7}body{background:radial-gradient(circle at 50% 38%,#26545066 0,${background} 62%)}header{height:150px;padding:42px 78px;background:#0b171cb8}header b{display:block;color:${accent};font-size:24px;letter-spacing:7px}header span{display:block;color:#bbd2cc;font-size:26px;margin-top:17px}.layout{height:770px;display:grid;grid-template-columns:${screenImage ? '620px 1fr' : '1fr 1fr'};align-items:center;gap:54px;padding:40px 70px}.people{display:${screenImage ? 'grid' : 'contents'};gap:28px}.person{text-align:center;opacity:.58}.person.active{opacity:1}.avatar{width:${screenImage ? 250 : 330}px;height:${screenImage ? 250 : 330}px;border:6px solid var(--color);box-shadow:0 0 10px var(--color);margin:auto;overflow:hidden;border-radius:50%;background:var(--color);display:grid;place-items:center}.active .avatar{border-width:14px;box-shadow:0 0 55px var(--color)}.avatar img{width:100%;height:100%;object-fit:cover}.avatar span{font-size:150px;font-weight:800;color:#173038}.person strong{display:block;font-size:34px;margin-top:24px}.person small{display:block;color:var(--color);font-size:18px;font-weight:800;letter-spacing:5px;margin-top:10px}.screen{height:690px;border:5px solid #487068;border-radius:26px;background:#081216;padding:18px;display:grid;place-items:center}.screen img{max-width:100%;max-height:100%;object-fit:contain}.caption{position:absolute;left:180px;right:180px;bottom:45px;min-height:100px;padding:20px 38px;border-radius:18px;background:#061013e8;text-align:center;font-size:42px;font-weight:700;line-height:1.23;display:flex;align-items:center;justify-content:center}.caption em{font-style:normal;color:${entry.role === 'host' ? accent : guestAccent};margin-right:18px}</style><header><b>THE SALES FORGE</b><span>${html(item.outline?.subject || 'AI PODCAST')}</span></header><main class="layout"><div class="people">${avatar(item.personas?.host, hostImage, 'host', accent)}${avatar(item.personas?.guest, guestImage, 'guest', guestAccent)}</div>${screenImage ? `<div class="screen"><img src="${screenImage}"></div>` : ''}</main>${settings.captionsEnabled === false ? '' : `<div class="caption"><em>${entry.role.toUpperCase()}</em>${html(entry.text)}</div>`}`;
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
  if (!item) throw new Error('Podcast not found.');
  await setEpisodeFields(episodeId, { videoStatus: 'processing', videoError: null });
  const sourceTimeline = podcastTimeline(item.events || [], { gap: 0 });
  const speechCount = sourceTimeline.filter(entry => entry.type === 'speech').length;
  const browserCount = sourceTimeline.filter(entry => entry.video).length;
  if (speechCount < 2) throw new Error('The podcast has too little completed speech to render.');
  if (item.settings?.requireGuestDemo && browserCount < 1) throw new Error('The required guest Computer Use demonstration is missing from the podcast timeline.');
  const browser = new VercelEpisodeSandbox(`render-${episodeId}`, () => {});
  try {
    const host = item.personas?.host || {}, guest = item.personas?.guest || {};
    const [hostBytes, guestBytes] = await Promise.all([optionalAsset(host.image), optionalAsset(guest.image)]);
    const hostImage = imageData(hostBytes, host.image), guestImage = imageData(guestBytes, guest.image);
    const parts = [];
    const timed = [];
    let cursor = 0;
    for (let index = 0; index < sourceTimeline.length; index++) {
      const entry = sourceTimeline[index];
      if (entry.type === 'speech') {
        const [audioBytes, screenBytes, actionBytes] = await Promise.all([readAssetBytes(entry.audio), optionalAsset(entry.screen), optionalAsset(entry.video)]);
        const audioPath = `/tmp/podcast-speech-${index}.mp3`;
        const trimmedAudioPath = `/tmp/podcast-speech-${index}.wav`;
        const stagePath = `/tmp/podcast-stage-${index}.png`;
        const segmentPath = `/tmp/podcast-part-${index}.mp4`;
        await browser.writeSandboxFile(audioPath, audioBytes);
        let result = await browser.run('ffmpeg', ['-y', '-i', audioPath, '-af', 'silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.01,areverse,silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.02,areverse', '-ar', '48000', '-ac', '2', trimmedAudioPath], 120000);
        if (result.exitCode) throw new Error(`Could not remove speech boundary silence ${index + 1}: ${(await result.stderr()).slice(-1200)}`);
        const audioDuration = await probeDuration(browser, trimmedAudioPath);
        const duration = audioDuration + entry.gap;
        await renderStage(browser, stagePath, stageHtml(item, entry, hostImage, guestImage, imageData(screenBytes, entry.screen)));
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
    await browser.writeSandboxFile('/tmp/podcast-parts.txt', parts.map(filename => `file '${filename}'`).join('\n'));
    await browser.writeSandboxFile('/tmp/podcast.srt', podcastCaptions(timed, { wholeSpeech: true, speakerLabels: true }));
    let result = await browser.run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', '/tmp/podcast-parts.txt', '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '/tmp/podcast-base.mp4'], 20 * 60 * 1000);
    if (result.exitCode) throw new Error(`Could not assemble the podcast timeline: ${(await result.stderr()).slice(-1200)}`);
    const finalArgs = ['-y', '-i', '/tmp/podcast-base.mp4', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', '/tmp/podcast-final.mp4'];
    result = await browser.run('ffmpeg', finalArgs, 20 * 60 * 1000);
    if (result.exitCode) throw new Error(`Could not burn podcast captions: ${(await result.stderr()).slice(-1200)}`);
    const quality = await inspectSandboxMedia(browser, '/tmp/podcast-final.mp4', { sceneThreshold: 0.008, silenceNoise: '-30dB', silenceDuration: .25 });
    const verdict = evaluateMediaQuality(quality, { interactive: Boolean(item.settings?.requireGuestDemo), minDuration: 4, maxSilencePercent: 15, maxSilenceSeconds: 1 });
    if (!verdict.passed) throw new Error(`Podcast quality check failed: ${verdict.failures.join(' ')}`);
    const [video, captions] = await Promise.all([browser.readSandboxFile('/tmp/podcast-final.mp4'), browser.readSandboxFile('/tmp/podcast.srt')]);
    const [mp4, captionUrl] = await Promise.all([putNamedAsset(`episode-${safe(episodeId)}.mp4`, video), putNamedAsset(`episode-${safe(episodeId)}.srt`, captions)]);
    await setEpisodeFields(episodeId, { mp4, captions: captionUrl, videoStatus: 'complete', videoError: null, quality, renderedAt: stamp() });
    return mp4;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function failPodcastRender(episodeId, message) {
  'use step';
  const item = await episode(episodeId);
  if (item?.creditsCharged && item.ownerId) await refundCredits(item.ownerId, item.creditsCharged, 'podcast', episodeId);
  await setEpisodeFields(episodeId, { status: 'failed', videoStatus: 'failed', videoError: String(message || 'Podcast rendering failed.').slice(0, 2000), error: String(message || 'Podcast rendering failed.').slice(0, 2000), endedAt: stamp() });
}
