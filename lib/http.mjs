import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { assets, usesRemoteAssets } from './store.mjs';

// Response and request helpers shared by the route modules. Responders return true so a route
// module can report that it handled the request.
export function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); return true; }
export function error(res, status, message) { return json(res, status, { error: message }); }
export async function body(req, limit = 18_000_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Request is too large.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
export async function rawBody(req, limit = 6_000_000) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('File is too large.'); chunks.push(chunk); } return Buffer.concat(chunks); }
export const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.webm': 'video/webm', '.mp4': 'video/mp4', '.txt': 'text/plain' };
export async function staticFile(req, res, base, filename) {
  const file = path.resolve(base, filename);
  if (!file.startsWith(path.resolve(base) + path.sep)) return error(res, 403, 'Forbidden');
  try {
    const info = await stat(file);
    if (!info.isFile()) return error(res, 404, 'Not found');
    const headers = { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (match) {
      const endInput = match[2] ? Number(match[2]) : info.size - 1;
      const start = match[1] ? Number(match[1]) : Math.max(0, info.size - endInput);
      const end = Math.min(info.size - 1, match[1] ? endInput : info.size - 1);
      if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return true; }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
      createReadStream(file, { start, end }).pipe(res);
    } else { res.writeHead(200, { ...headers, 'Content-Length': info.size }); createReadStream(file).pipe(res); }
  } catch { error(res, 404, 'Not found'); }
  return true;
}
export async function assetFile(req, res, filename) {
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) return error(res, 400, 'Invalid asset name');
  if (!usesRemoteAssets()) return staticFile(req, res, assets, filename);
  const { get } = await import('@vercel/blob');
  const result = await get(`assets/${filename}`, { access: 'private', headers: req.headers.range ? { Range: req.headers.range } : undefined });
  if (!result?.stream) return error(res, 404, 'Not found');
  const headers = { 'Content-Type': result.blob.contentType || mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  for (const name of ['content-length', 'content-range', 'accept-ranges']) {
    const value = result.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(result.statusCode, headers);
  await pipeline(Readable.fromWeb(result.stream), res);
  return true;
}

