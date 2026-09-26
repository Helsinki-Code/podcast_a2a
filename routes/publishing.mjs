import { randomBytes } from 'node:crypto';
import { episode, explainer, setEpisodeFields, setExplainerFields, reserveCredits, podcastFeed, savePodcastFeed, integration, deleteIntegration, stamp } from '../lib/store.mjs';
import { costs } from '../lib/billing.mjs';
import { exportFile } from '../lib/publishing.mjs';
import { integrationsConfigured, signState } from '../lib/secure.mjs';
import { youtubeAuthUrl, youtubeConfigured } from '../lib/youtube.mjs';
import { json, error, body } from '../lib/http.mjs';

// Follow-up publishing on finished videos: exports, shorts, translations, dubs, YouTube, and the
// podcast feed. Long jobs run as durable workflows on Vercel and in-process locally.
const LANGUAGE_CODES = ['es', 'fr', 'de', 'pt', 'it', 'nl', 'ja', 'ko', 'zh', 'hi', 'ar', 'en'];
const appUrl = req => process.env.NEXT_PUBLIC_APP_URL || `${String(req.headers['x-forwarded-proto'] || 'http').split(',')[0]}://${req.headers.host}`;

async function runJob(name, args) {
  const workflows = await import('../workflows/publish.mjs');
  if (process.env.VERCEL) {
    const { start } = await import('workflow/api');
    return (await start(workflows[name], args)).runId;
  }
  setImmediate(() => workflows[name](...args).catch(console.error));
  return null;
}

async function loadOwned(kind, id, userId) {
  const item = kind === 'podcast' ? await episode(id) : await explainer(id);
  return item && item.ownerId === userId ? item : null;
}

export async function handle({ req, res, url, parts, auth }) {
  if (url.pathname === '/api/integrations' && req.method === 'GET') {
    const youtube = await integration(auth.userId, 'youtube');
    return json(res, 200, { youtube: { configured: youtubeConfigured() && integrationsConfigured(), connected: Boolean(youtube), channel: youtube?.profile?.channel || null } });
  }
  if (url.pathname === '/api/integrations/youtube/connect' && req.method === 'POST') {
    if (!youtubeConfigured() || !integrationsConfigured()) return error(res, 409, 'YouTube publishing is not configured on this workspace yet.');
    return json(res, 200, { url: youtubeAuthUrl(signState({ userId: auth.userId, provider: 'youtube' }), `${appUrl(req)}/api/integrations/youtube/callback`) });
  }
  if (url.pathname === '/api/integrations/youtube' && req.method === 'DELETE') {
    await deleteIntegration(auth.userId, 'youtube');
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/feed' && req.method === 'GET') {
    const feed = await podcastFeed(auth.userId);
    return json(res, 200, feed ? { ...feed, url: `${appUrl(req)}/feeds/${feed.token}.xml` } : { enabled: false });
  }
  if (url.pathname === '/api/feed' && req.method === 'PUT') {
    const input = await body(req, 10_000);
    const current = await podcastFeed(auth.userId);
    const token = input.rotate || !current?.token ? randomBytes(20).toString('hex') : current.token;
    const feed = await savePodcastFeed(auth.userId, token, {
      enabled: input.enabled !== false,
      title: String(input.title || current?.title || 'My podcast').trim().slice(0, 120),
      description: String(input.description ?? current?.description ?? '').trim().slice(0, 2000),
      author: String(input.author ?? current?.author ?? '').trim().slice(0, 120),
      updatedAt: stamp()
    });
    return json(res, 200, { ...feed, url: `${appUrl(req)}/feeds/${feed.token}.xml` });
  }

  const kind = parts[1] === 'episodes' ? 'podcast' : parts[1] === 'explainers' ? 'explainer' : null;
  if (parts[0] !== 'api' || !kind || !parts[2] || !parts[3]) return false;
  const job = parts[3];
  if (!['export', 'shorts', 'translate', 'dub', 'youtube', 'feed'].includes(job)) return false;
  const item = await loadOwned(kind, parts[2], auth.userId);
  if (!item) return error(res, 404, `${kind === 'podcast' ? 'Episode' : 'Explainer'} not found`);
  const setFields = kind === 'podcast' ? setEpisodeFields : setExplainerFields;
  const finished = Boolean(item.mp4 || (kind === 'explainer' && item.video)) && ['complete', 'stopped'].includes(item.status);

  if (job === 'export' && req.method === 'GET') {
    const language = String(url.searchParams.get('lang') || '');
    const timeline = language ? item.translations?.[language]?.timeline : item.timeline;
    if (!timeline?.length) return error(res, 404, language ? 'Translate the captions into that language first.' : 'This video has no timed transcript yet.');
    const title = kind === 'podcast' ? item.outline?.subject : item.title;
    const file = exportFile(timeline, String(url.searchParams.get('format') || 'srt'), title);
    if (!file) return error(res, 400, 'Format must be srt, vtt, words, txt, or json.');
    const stem = String(title || kind).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || kind;
    res.writeHead(200, { 'Content-Type': file.type, 'Content-Disposition': `attachment; filename="${stem}${language ? `.${language}` : ''}.${file.extension}"`, 'Cache-Control': 'no-store' });
    res.end(file.body);
    return true;
  }
  if (req.method !== 'POST') return false;
  if (!finished) return error(res, 409, 'Finish the video before publishing it.');
  const input = await body(req, 20_000);

  if (job === 'feed') {
    if (kind !== 'podcast') return error(res, 400, 'Only podcasts can be added to the podcast feed.');
    if (!item.mp3?.url) return error(res, 409, 'This episode has no audio master yet. Re-render it to create one.');
    await setFields(item.id, { inFeed: input.include !== false, feedPublishedAt: item.feedPublishedAt || stamp() });
    return json(res, 200, { inFeed: input.include !== false });
  }
  if (job === 'shorts') {
    if (item.shortsStatus === 'processing') return error(res, 409, 'Shorts are already being made.');
    const attempt = (Number(item.shortsAttempt) || 0) + 1, reference = `${item.id}:shorts-${attempt}`;
    if (!await reserveCredits(auth.userId, costs.shorts, kind, reference)) return error(res, 402, `Shorts need ${costs.shorts} credits.`);
    await setFields(item.id, { shortsStatus: 'processing', shortsError: null, shortsAttempt: attempt, shortsCredits: costs.shorts, shortsReference: reference });
    await runJob('shortsWorkflow', [kind, item.id]);
    return json(res, 202, { ok: true });
  }
  if (job === 'translate' || job === 'dub') {
    const language = String(input.language || '');
    if (!LANGUAGE_CODES.includes(language)) return error(res, 400, 'Choose a supported language.');
    const entry = item.translations?.[language] || {};
    if (job === 'dub' && entry.dubStatus === 'processing') return error(res, 409, 'That dub is already in progress.');
    const price = job === 'dub' ? (kind === 'podcast' ? costs.dubPodcast : costs.dubExplainer) : costs.translation;
    const attempt = (Number(job === 'dub' ? entry.dubAttempt : entry.attempt) || 0) + 1;
    const reference = `${item.id}:${job}-${language}-${attempt}`;
    if (!await reserveCredits(auth.userId, price, kind, reference)) return error(res, 402, `This needs ${price} credits.`);
    const next = job === 'dub' ? { ...entry, dubStatus: 'processing', dubError: null, dubAttempt: attempt, dubCredits: price, dubReference: reference } : { ...entry, language, status: 'processing', error: null, attempt, credits: price, reference };
    await setFields(item.id, { translations: { ...(item.translations || {}), [language]: next } });
    await runJob(job === 'dub' ? 'dubWorkflow' : 'translateWorkflow', [kind, item.id, language]);
    return json(res, 202, { ok: true });
  }
  if (job === 'youtube') {
    if (!await integration(auth.userId, 'youtube')) return error(res, 409, 'Connect a YouTube channel first.');
    if (item.youtubeUpload?.status === 'uploading') return error(res, 409, 'This video is already uploading.');
    const options = { privacy: ['private', 'unlisted', 'public'].includes(input.privacy) ? input.privacy : 'private', title: String(input.title || '').slice(0, 100), description: input.description == null ? undefined : String(input.description).slice(0, 4900) };
    await setFields(item.id, { youtubeUpload: { status: 'uploading', startedAt: stamp(), privacy: options.privacy } });
    await runJob('youtubeUploadWorkflow', [kind, item.id, options]);
    return json(res, 202, { ok: true });
  }
  return false;
}
