// Minimal YouTube Data API client: OAuth (upload scope only), resumable upload, and thumbnails.
const SCOPE = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';

export const youtubeConfigured = () => Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET);

export function youtubeAuthUrl(state, redirectUri) {
  const params = new URLSearchParams({ client_id: process.env.YOUTUBE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(fields) {
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.YOUTUBE_CLIENT_ID, client_secret: process.env.YOUTUBE_CLIENT_SECRET, ...fields }), signal: AbortSignal.timeout(30000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Google sign-in failed: ${data.error_description || data.error || response.status}`);
  return data;
}

export const exchangeYoutubeCode = (code, redirectUri) => tokenRequest({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
export async function youtubeAccessToken(refreshToken) { return (await tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' })).access_token; }

export async function youtubeChannel(accessToken) {
  const response = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30000) });
  const data = await response.json().catch(() => ({}));
  const channel = data.items?.[0];
  return channel ? { id: channel.id, title: channel.snippet?.title || '' } : null;
}

export async function uploadToYoutube({ accessToken, bytes, title, description, tags = [], privacy = 'private' }) {
  const metadata = { snippet: { title: String(title).slice(0, 100), description: String(description || '').slice(0, 4900), tags: tags.slice(0, 30), categoryId: '28' }, status: { privacyStatus: ['private', 'unlisted', 'public'].includes(privacy) ? privacy : 'private', selfDeclaredMadeForKids: false } };
  const start = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(bytes.length) },
    body: JSON.stringify(metadata), signal: AbortSignal.timeout(60000)
  });
  if (!start.ok) throw new Error(`YouTube refused the upload: ${(await start.text()).slice(0, 400)}`);
  const location = start.headers.get('location');
  if (!location) throw new Error('YouTube did not return an upload location.');
  const upload = await fetch(location, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) }, body: bytes, signal: AbortSignal.timeout(15 * 60 * 1000) });
  const video = await upload.json().catch(() => ({}));
  if (!upload.ok || !video.id) throw new Error(`YouTube upload failed: ${JSON.stringify(video.error || video).slice(0, 400)}`);
  return { id: video.id, url: `https://www.youtube.com/watch?v=${video.id}` };
}

export async function setYoutubeThumbnail(accessToken, videoId, jpeg) {
  const response = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'image/jpeg' }, body: jpeg, signal: AbortSignal.timeout(60000) });
  // Custom thumbnails need a verified channel; a refusal is reported but never fails the upload.
  return response.ok ? null : `Thumbnail not applied: ${(await response.text()).slice(0, 200)}`;
}
