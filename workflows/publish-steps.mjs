import { captureError } from '../lib/monitor.mjs';
import { enterUsage } from '../lib/usage.mjs';
import { episode, explainer, setEpisodeFields, setExplainerFields, putNamedAsset, readAssetBytes, refundCredits, stamp } from '../lib/store.mjs';
import { modelProviders, speechProviders, supportedVoice } from '../lib/providers.mjs';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';
import { shortsPrompt, validateShortRanges, heuristicShorts, verticalFilter, shortTitleHtml } from '../lib/shorts.mjs';
import { toSrt, toVtt } from '../lib/publishing.mjs';
import { podcastTimeline } from '../lib/podcast-timeline.mjs';
import { DEFAULT_VOICES } from '../lib/cast.mjs';
import { modelFor } from '../lib/models.mjs';
import { assemblePodcast } from './podcast-render-steps.mjs';
import { revoiceScenes, mixExplainer } from './explainer-steps.mjs';

// Follow-up media jobs on a finished podcast or explainer: vertical shorts, translated captions,
// and dubbed variants. Each job records its own status so it never disturbs the main video.
export const LANGUAGES = { es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', nl: 'Dutch', ja: 'Japanese', ko: 'Korean', zh: 'Chinese (Simplified)', hi: 'Hindi', ar: 'Arabic', en: 'English' };
const safe = value => String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_');
const load = kind => kind === 'podcast' ? episode : explainer;
const update = kind => kind === 'podcast' ? setEpisodeFields : setExplainerFields;
const titleOf = (kind, item) => kind === 'podcast' ? item.outline?.subject : item.title;

export async function renderShorts(kind, id) {
  'use step';
  const item = await load(kind)(id);
  enterUsage({ ownerId: item?.ownerId, kind, id });
  const timeline = item?.timeline || [];
  if (!item?.mp4 && !item?.video) throw new Error('Render the video before making shorts.');
  if (!timeline.length) throw new Error('This video has no timed transcript to cut shorts from.');
  let clips = [];
  const provider = modelProviders.get('gateway');
  if (provider?.ready?.()) {
    try { clips = validateShortRanges(timeline, (await provider.generate(shortsPrompt(timeline, titleOf(kind, item)), modelFor('metadata'), { user: item.ownerId, tags: ['feature:shorts'] }))?.clips || []); } catch {}
  }
  if (!clips.length) clips = heuristicShorts(timeline);
  if (!clips.length) throw new Error('No 15–58 second highlight could be found in this video.');
  const browser = new VercelEpisodeSandbox(`shorts-${id}`, () => {});
  try {
    await browser.writeSandboxFile('/tmp/shorts-source.mp4', await readAssetBytes(item.mp4 || item.video));
    const shorts = [];
    for (const [index, clip] of clips.entries()) {
      await browser.writeSandboxFile(`/tmp/short-title-${index}.html`, shortTitleHtml(clip.title, item.settings?.accent || item.brand?.accentColor));
      await browser.setViewport(1920, 1080);
      await browser.command(['open', `file:///tmp/short-title-${index}.html`]);
      await browser.command(['wait', '250']);
      await browser.command(['screenshot', `/tmp/short-title-${index}.png`]);
      const output = `/tmp/short-${index}.mp4`;
      const length = (clip.end - clip.start).toFixed(3);
      const result = await browser.run('ffmpeg', ['-y', '-ss', clip.start.toFixed(3), '-t', length, '-i', '/tmp/shorts-source.mp4', '-loop', '1', '-i', `/tmp/short-title-${index}.png`, '-filter_complex', verticalFilter(), '-map', '[v]', '-map', '0:a', '-t', length, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-af', `afade=t=in:d=0.3,afade=t=out:st=${Math.max(0, clip.end - clip.start - 0.5).toFixed(2)}:d=0.5`, '-movflags', '+faststart', output], 10 * 60 * 1000);
      if (result.exitCode) throw new Error(`Could not render short ${index + 1}: ${(await result.stderr()).slice(-800)}`);
      shorts.push({ title: clip.title, start: clip.start, end: clip.end, video: await putNamedAsset(`${kind}-${safe(id)}-short-${index + 1}.mp4`, await browser.readSandboxFile(output)) });
    }
    await update(kind)(id, { shorts, shortsStatus: 'complete', shortsError: null, shortsCredits: 0 });
    return shorts;
  } finally {
    await browser.close().catch(() => {});
  }
}

// Translates the timed transcript line by line so the original timing still fits.
async function translateTimeline(item, timeline, language) {
  const provider = modelProviders.get('gateway');
  if (!provider?.ready?.()) throw new Error('Translation needs the AI Gateway to be configured.');
  const translated = [];
  for (let offset = 0; offset < timeline.length; offset += 40) {
    const batch = timeline.slice(offset, offset + 40);
    const result = await provider.generate([
      { role: 'system', content: `Translate spoken video lines into ${LANGUAGES[language]}. Return JSON {"lines":[string]} with exactly ${batch.length} entries in the same order. Keep names, product names, and UI labels as they appear on screen. Keep each line about as long as the original so it fits the same timing. Natural spoken register.` },
      { role: 'user', content: JSON.stringify(batch.map(part => part.text)) }
    ], modelFor('metadata'), { user: item.ownerId, tags: ['feature:translate'] });
    const lines = Array.isArray(result?.lines) ? result.lines : [];
    if (lines.length !== batch.length) throw new Error('The translation did not return one line per caption. Try again.');
    batch.forEach((part, index) => translated.push({ ...part, text: String(lines[index] || part.text).trim() }));
  }
  return translated;
}

export async function translateMedia(kind, id, language) {
  'use step';
  return translateAndStore(kind, id, language);
}

async function translateAndStore(kind, id, language) {
  if (!LANGUAGES[language]) throw new Error('Unsupported language.');
  const item = await load(kind)(id);
  if (!item?.timeline?.length) throw new Error('This video has no timed transcript to translate.');
  enterUsage({ ownerId: item.ownerId, kind, id });
  const timeline = await translateTimeline(item, item.timeline, language);
  const stem = `${kind}-${safe(id)}-${language}`;
  const [captions, vtt] = await Promise.all([putNamedAsset(`${stem}.srt`, toSrt(timeline)), putNamedAsset(`${stem}.vtt`, toVtt(timeline))]);
  const translations = { ...(item.translations || {}), [language]: { ...(item.translations?.[language] || {}), language, timeline, captions, vtt, status: 'complete', error: null, credits: 0, updatedAt: stamp() } };
  await update(kind)(id, { translations });
  return translations[language];
}

// Re-voices the programme in another language. Podcasts keep each persona's voice; explainers keep
// the narrator's. The recorded picture is reused; only speech, timing, and captions change.
export async function dubMedia(kind, id, language) {
  'use step';
  if (!LANGUAGES[language]) throw new Error('Unsupported language.');
  let item = await load(kind)(id);
  enterUsage({ ownerId: item?.ownerId, kind, id });
  if (!item?.translations?.[language]?.timeline) {
    await translateAndStore(kind, id, language);
    item = await load(kind)(id);
  }
  const translatedLines = item.translations[language].timeline.map(part => part.text);
  const browser = new VercelEpisodeSandbox(`dub-${id}`, () => {});
  try {
    let video, captions;
    if (kind === 'podcast') {
      const source = podcastTimeline(item.events || [], { gap: 0 }).filter(entry => entry.type === 'speech');
      if (source.length !== translatedLines.length) throw new Error('The transcript changed since it was translated. Translate it again.');
      const dubbed = [];
      for (const [index, entry] of source.entries()) {
        const persona = item.personas?.[entry.role] || {};
        const providerName = persona.speechProvider || 'gateway';
        const speech = speechProviders.get(providerName);
        if (!speech) throw new Error(`Speech provider unavailable: ${providerName}`);
        const generated = await speech.synthesize(translatedLines[index], supportedVoice(providerName, persona.voice, DEFAULT_VOICES[entry.role] || 'nova'), { style: persona.voiceStyle });
        const chunks = [];
        for await (const chunk of Buffer.isBuffer(generated) || generated instanceof Uint8Array ? [generated] : generated) chunks.push(Buffer.from(chunk));
        const audio = await putNamedAsset(`dub-${safe(id)}-${language}-${index}.mp3`, Buffer.concat(chunks));
        dubbed.push({ ...entry, text: translatedLines[index], audio });
      }
      const fields = await assemblePodcast(browser, item, dubbed, { stem: `episode-${safe(id)}-${language}`, variant: true });
      video = fields.mp4; captions = fields.captions;
    } else {
      if (!item.scenes?.length || item.scenes.length !== translatedLines.length) throw new Error('This explainer has no saved scenes matching its transcript. Re-render it first.');
      const timeline = await revoiceScenes(browser, item, translatedLines);
      const output = await mixExplainer(browser, id, item, timeline, { variant: language });
      video = output.video; captions = output.captions;
      await setExplainerFields(id, { progress: 'Complete' });
    }
    const fresh = await load(kind)(id);
    const translations = { ...(fresh.translations || {}), [language]: { ...(fresh.translations?.[language] || {}), dubbedVideo: video, dubbedCaptions: captions, dubStatus: 'complete', dubError: null, dubCredits: 0, dubbedAt: stamp() } };
    await update(kind)(id, { translations });
    return translations[language];
  } finally {
    await browser.close().catch(() => {});
  }
}

// Marks a follow-up job failed and refunds its reservation, leaving the main video untouched.
export async function failPublishJob(kind, id, job, message, language = '') {
  'use step';
  await captureError(new Error(message || 'Publishing job failed.'), { kind, id, stage: job, language });
  const item = await load(kind)(id);
  if (!item) return;
  const reason = String(message || 'The job failed.').slice(0, 1200);
  if (job === 'shorts') {
    if (item.shortsCredits && item.ownerId) await refundCredits(item.ownerId, item.shortsCredits, kind, item.shortsReference || `${id}:shorts`);
    await update(kind)(id, { shortsStatus: 'failed', shortsError: reason, shortsCredits: 0 });
    return;
  }
  const entry = item.translations?.[language] || {};
  const field = job === 'dub' ? { dubStatus: 'failed', dubError: reason, dubCredits: 0 } : { status: 'failed', error: reason, credits: 0 };
  const credits = job === 'dub' ? entry.dubCredits : entry.credits;
  if (credits && item.ownerId) await refundCredits(item.ownerId, credits, kind, job === 'dub' ? entry.dubReference : entry.reference);
  await update(kind)(id, { translations: { ...(item.translations || {}), [language]: { ...entry, ...field } } });
}

// Uploads the finished MP4 (and thumbnail) to the owner's connected YouTube channel.
export async function uploadYoutube(kind, id, options = {}) {
  'use step';
  const { integration } = await import('../lib/store.mjs');
  const { decryptJson } = await import('../lib/secure.mjs');
  const { youtubeAccessToken, uploadToYoutube, setYoutubeThumbnail } = await import('../lib/youtube.mjs');
  const item = await load(kind)(id);
  const connection = await integration(item.ownerId, 'youtube');
  if (!connection) throw new Error('Connect a YouTube channel first.');
  const { refreshToken } = decryptJson(connection.secret);
  const accessToken = await youtubeAccessToken(refreshToken);
  const bytes = await readAssetBytes(item.mp4 || item.video);
  const meta = item.youtube || {};
  const uploaded = await uploadToYoutube({ accessToken, bytes, title: options.title || meta.title || titleOf(kind, item), description: options.description ?? meta.description ?? '', tags: meta.tags || [], privacy: options.privacy });
  const thumbnailNote = item.thumbnail ? await setYoutubeThumbnail(accessToken, uploaded.id, await readAssetBytes(item.thumbnail)).catch(error => error.message) : null;
  await update(kind)(id, { youtubeUpload: { status: 'complete', videoId: uploaded.id, url: uploaded.url, privacy: options.privacy || 'private', note: thumbnailNote, uploadedAt: stamp() } });
  return uploaded;
}

export async function failYoutubeUpload(kind, id, message) {
  'use step';
  await captureError(new Error(message || 'YouTube upload failed.'), { kind, id, stage: 'youtube' });
  await update(kind)(id, { youtubeUpload: { status: 'failed', error: String(message || 'Upload failed.').slice(0, 600), failedAt: stamp() } });
}
