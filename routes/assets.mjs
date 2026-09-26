import { episode, assetOwnedBy } from '../lib/store.mjs';
import { openLiveAudio } from '../lib/audio.mjs';
import { json, error, body, assetFile } from '../lib/http.mjs';

// Private media: direct Blob uploads for recorded takes, speech audio, and owner-scoped assets.
export async function handle({ req, res, url, parts, auth, userAccount }) {
  if (url.pathname === '/api/blob/upload' && req.method === 'POST') {
    const data = await body(req, 10000);
    const { handleUpload } = await import('@vercel/blob/client');
    const protocol = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
    const host = req.headers.host || 'localhost';
    const result = await handleUpload({
      body: data,
      request: new Request(`${protocol}://${host}${url.pathname}`, { method: 'POST', headers: req.headers }),
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const episodeId = String(clientPayload || '');
        if (!/^[a-f0-9-]{36}$/i.test(episodeId) || !new RegExp(`^assets/episode-${episodeId}-[a-f0-9-]{36}\\.webm$`, 'i').test(pathname)) throw new Error('Invalid episode video path.');
        const ownedEpisode = await episode(episodeId);
        if (!ownedEpisode || ownedEpisode.ownerId !== auth.userId) throw new Error('Episode not found.');
        return { allowedContentTypes: ['video/webm'], addRandomSuffix: false, maximumSizeInBytes: 2_000_000_000 };
      },
      onUploadCompleted: async () => {}
    });
    return json(res, 200, result);
  }
  if (parts[0] === 'api' && parts[1] === 'audio' && parts[2] && req.method === 'GET') {
    const id = parts[2]; if (!/^[a-f0-9-]{36}$/i.test(id)) return error(res, 400, 'Invalid audio ID');
    if (!await assetOwnedBy(auth.userId, id)) return error(res, 404, 'Audio not found');
    if (openLiveAudio(id, req, res)) return true;
    return assetFile(req, res, `${id}.mp3`);
  }
  if (parts[0] === 'assets' && req.method === 'GET') { const filename = parts.slice(1).join('/'); if (!await assetOwnedBy(auth.userId, filename)) return error(res, 404, 'Asset not found'); return assetFile(req, res, filename); }
  if (parts[0] === 'api' && parts[1] === '_assets' && req.method === 'GET') { const filename = parts.slice(2).join('/'); if (!await assetOwnedBy(auth.userId, filename)) return error(res, 404, 'Asset not found'); return assetFile(req, res, filename); }
  return false;
}
