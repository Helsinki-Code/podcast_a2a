import { listEpisodes, podcastFeedByToken, saveIntegration, readAssetBytes } from '../lib/store.mjs';
import { podcastFeedXml } from '../lib/publishing.mjs';
import { encryptJson, verifyState } from '../lib/secure.mjs';
import { exchangeYoutubeCode, youtubeChannel } from '../lib/youtube.mjs';
import { error } from '../lib/http.mjs';

// Routes reachable without a Clerk session: the podcast RSS feed (secured by its unguessable
// token) and the OAuth redirect back from Google (secured by a signed, expiring state).
const appUrl = req => process.env.NEXT_PUBLIC_APP_URL || `${String(req.headers['x-forwarded-proto'] || 'http').split(',')[0]}://${req.headers.host}`;

async function feedEpisodes(feed) {
  return (await listEpisodes(feed.ownerId)).filter(item => item.inFeed && item.mp3?.url).sort((a, b) => String(b.feedPublishedAt || b.createdAt).localeCompare(String(a.feedPublishedAt || a.createdAt)));
}

export async function handle({ req, res, url, parts }) {
  const feedParts = parts[0] === 'feeds' ? parts.slice(1) : parts[0] === 'api' && parts[1] === 'feeds' ? parts.slice(2) : null;
  if (feedParts && req.method === 'GET') {
    const token = feedParts[0]?.replace(/\.xml$/, '');
    const feed = await podcastFeedByToken(token);
    if (!feed?.enabled) return error(res, 404, 'Feed not found');
    const base = `${appUrl(req)}/feeds/${feed.token}`;
    const items = await feedEpisodes(feed);
    if (feedParts.length === 1 && feedParts[0].endsWith('.xml')) {
      const media = reference => reference ? `${base}/media/${reference.split('/').pop()}` : '';
      const xml = podcastFeedXml({ title: feed.title, description: feed.description || feed.title, author: feed.author, link: appUrl(req), image: media(items[0]?.thumbnail), items: items.map(item => ({ id: item.id, title: item.youtube?.title || item.outline?.subject, description: item.youtube?.description || item.outline?.subject, date: item.feedPublishedAt || item.createdAt, url: media(item.mp3.url), bytes: item.mp3.bytes, duration: item.mp3.duration, image: media(item.thumbnail) })) });
      res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      res.end(xml);
      return true;
    }
    if (feedParts[1] === 'media' && /^[a-zA-Z0-9._-]+\.(mp3|jpg)$/.test(feedParts[2] || '')) {
      const filename = feedParts[2];
      const allowed = items.some(item => [item.mp3.url, item.thumbnail].some(reference => reference?.endsWith(`/${filename}`)));
      if (!allowed) return error(res, 404, 'Not found');
      const bytes = await readAssetBytes(`/assets/${filename}`);
      res.writeHead(200, { 'Content-Type': filename.endsWith('.mp3') ? 'audio/mpeg' : 'image/jpeg', 'Content-Length': bytes.length, 'Cache-Control': 'public, max-age=86400' });
      res.end(bytes);
      return true;
    }
    return error(res, 404, 'Not found');
  }
  if (url.pathname === '/api/integrations/youtube/callback' && req.method === 'GET') {
    const state = verifyState(url.searchParams.get('state'));
    const done = outcome => { res.writeHead(302, { Location: `/?youtube=${outcome}` }); res.end(); return true; };
    if (!state || state.provider !== 'youtube') return done('expired');
    if (url.searchParams.get('error')) return done('denied');
    try {
      const tokens = await exchangeYoutubeCode(String(url.searchParams.get('code') || ''), `${appUrl(req)}/api/integrations/youtube/callback`);
      if (!tokens.refresh_token) return done('no-refresh-token');
      const channel = await youtubeChannel(tokens.access_token).catch(() => null);
      await saveIntegration(state.userId, 'youtube', encryptJson({ refreshToken: tokens.refresh_token }), { channel, connectedAt: new Date().toISOString() });
      return done('connected');
    } catch { return done('failed'); }
  }
  return false;
}
