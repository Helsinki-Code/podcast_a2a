import http from 'node:http';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat, readdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initStore, listPersonas, listEpisodes, persona, episode, addPersona, updatePersona, deletePersona, addEpisode, putAsset, save, assets, uid, stamp } from './lib/store.mjs';
import { availableProviders } from './lib/providers.mjs';
import { runEpisode, stopEpisode } from './lib/engine.mjs';
import { openLiveAudio } from './lib/audio.mjs';
import { buildIndex } from './lib/rag.mjs';
import './lib/sandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, '.env');
try {
  const raw = await readFile(envFile, 'utf8');
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }

await initStore();
try {
  for (const name of await readdir(path.join(here, 'plugins'))) if (name.endsWith('.mjs')) await import(path.join(here, 'plugins', name));
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const listeners = new Map();
const acknowledgements = new Map();

function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
function error(res, status, message) { json(res, status, { error: message }); }
async function body(req, limit = 18_000_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Request is too large.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
async function rawBody(req, limit = 6_000_000) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('File is too large.'); chunks.push(chunk); } return Buffer.concat(chunks); }
async function transcode(input, output) {
  return new Promise(resolve => {
    const proc = spawn('ffmpeg', ['-y','-i',input,'-c:v','libx264','-preset','veryfast','-crf','22','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',output], { stdio: 'ignore' });
    proc.on('error', () => resolve(false)); proc.on('exit', code => resolve(code === 0));
  });
}
function publish(id, event) {
  for (const res of listeners.get(id) || []) res.write(`data: ${JSON.stringify(event)}\n\n`);
}
function waitForAck(id, eventId, isStopped) {
  return new Promise((resolve, reject) => {
    const key = `${id}:${eventId}`;
    const timeout = setTimeout(() => { acknowledgements.delete(key); reject(new Error('Playback client disconnected or did not acknowledge speech.')); }, 180000);
    const interval = setInterval(() => { if (isStopped()) { clearTimeout(timeout); clearInterval(interval); acknowledgements.delete(key); resolve(); } }, 500);
    acknowledgements.set(key, () => { clearTimeout(timeout); clearInterval(interval); acknowledgements.delete(key); resolve(); });
  });
}
function cleanPersona(input) {
  const name = String(input.name || '').trim().slice(0, 80);
  const systemPrompt = String(input.systemPrompt || '').trim().slice(0, 12000);
  if (!name || !systemPrompt) throw new Error('Persona name and system prompt are required.');
  const knowledge = (Array.isArray(input.knowledge) ? input.knowledge : []).slice(0, 20).map(k => ({ name: String(k.name || 'notes.txt').slice(0, 100), text: String(k.text || '').slice(0, 250000) }));
  const image = String(input.image || '');
  if (image.length > 5_000_000 || (image && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image))) throw new Error('Upload a PNG, JPEG, or WebP display image under 3 MB.');
  return { name, systemPrompt, knowledge, knowledgeIndex: buildIndex(knowledge), image, modelProvider: String(input.modelProvider || 'openai'), model: String(input.model || '').slice(0, 80), speechProvider: String(input.speechProvider || 'openai'), voice: String(input.voice || 'alloy').slice(0, 100) };
}
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.webm': 'video/webm', '.mp4': 'video/mp4', '.txt': 'text/plain' };
async function staticFile(req, res, base, filename) {
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
      if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
      createReadStream(file, { start, end }).pipe(res);
    } else { res.writeHead(200, { ...headers, 'Content-Length': info.size }); createReadStream(file).pipe(res); }
  } catch { error(res, 404, 'Not found'); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/' && req.method === 'GET') return staticFile(req, res, path.join(here, 'public'), 'index.html');
    if (parts[0] === 'api' && parts[1] === 'audio' && parts[2] && req.method === 'GET') {
      const id = parts[2]; if (!/^[a-f0-9-]{36}$/i.test(id)) return error(res, 400, 'Invalid audio ID');
      if (openLiveAudio(id, req, res)) return;
      return staticFile(req, res, assets, `${id}.mp3`);
    }
    if (parts[0] === 'assets' && req.method === 'GET') return staticFile(req, res, assets, parts.slice(1).join('/'));
    if (parts[0] === 'public' && req.method === 'GET') return staticFile(req, res, path.join(here, 'public'), parts.slice(1).join('/'));
    if (url.pathname === '/api/config' && req.method === 'GET') {
      const providers = availableProviders();
      return json(res, 200, { providers, ready: { model: Object.values(providers.ready.models).some(Boolean), sandbox: !!process.env.E2B_API_KEY } });
    }
    if (url.pathname === '/api/extract' && req.method === 'POST') {
      const filename = String(url.searchParams.get('name') || '');
      const file = await rawBody(req);
      let text;
      if (/\.pdf$/i.test(filename)) {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(file), useSystemFonts: true }).promise;
        const pages = [];
        for (let i = 1; i <= Math.min(pdf.numPages, 100); i++) {
          const page = await pdf.getPage(i); const content = await page.getTextContent();
          pages.push(content.items.map(item => item.str).join(' '));
        }
        text = pages.join('\n\n');
      } else if (/\.docx$/i.test(filename)) {
        const mammoth = await import('mammoth');
        text = (await mammoth.extractRawText({ buffer: file })).value;
      } else throw new Error('Supported files: PDF and DOCX.');
      return json(res, 200, { text: text.slice(0, 250000) });
    }
    if (url.pathname === '/api/personas' && req.method === 'GET') return json(res, 200, listPersonas());
    if (url.pathname === '/api/personas' && req.method === 'POST') {
      const input = cleanPersona(await body(req));
      const item = { ...input, id: uid(), createdAt: stamp() };
      await addPersona(item); return json(res, 201, item);
    }
    if (parts[0] === 'api' && parts[1] === 'personas' && parts[2] && req.method === 'PUT') {
      const item = await updatePersona(parts[2], cleanPersona(await body(req)));
      return item ? json(res, 200, item) : error(res, 404, 'Persona not found');
    }
    if (parts[0] === 'api' && parts[1] === 'personas' && parts[2] && req.method === 'DELETE') {
      if (!persona(parts[2])) return error(res, 404, 'Persona not found');
      await deletePersona(parts[2]); return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/episodes' && req.method === 'GET') return json(res, 200, listEpisodes().map(({ events, ...rest }) => rest));
    if (url.pathname === '/api/episodes' && req.method === 'POST') {
      const input = await body(req);
      const hostPersona = persona(input.hostId), guestPersona = persona(input.guestId);
      if (!hostPersona || !guestPersona) throw new Error('Select a valid host and guest.');
      if (input.hostId === input.guestId) throw new Error('Host and guest must be different personas.');
      const subject = String(input.outline?.subject || '').trim().slice(0, 200);
      if (!subject) throw new Error('The subject is required.');
      const validColor = (color, fallback) => /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
      const fullHD = Number(input.settings?.width) === 1920 && Number(input.settings?.height) === 1080;
      const item = {
        id: uid(), createdAt: stamp(), status: 'draft', hostId: input.hostId, guestId: input.guestId,
        personas: { host: structuredClone(hostPersona), guest: structuredClone(guestPersona) },
        outline: { subject, angle: String(input.outline?.angle || '').slice(0, 500), points: String(input.outline?.points || '').slice(0, 2500) },
        settings: {
          interjections: input.settings?.interjections !== false,
          interjectProbability: Math.max(0, Math.min(.25, Number(input.settings?.interjectProbability) || 0)),
          hostTools: !!input.settings?.hostTools,
          maxMinutes: Math.max(1, Math.min(180, Number(input.settings?.maxMinutes) || 30)),
          width: fullHD ? 1920 : 1280,
          height: fullHD ? 1080 : 720,
          outputFormat: ['both','mp4','webm'].includes(input.settings?.outputFormat) ? input.settings.outputFormat : 'both',
          accent: validColor(input.settings?.accent, '#80ded1'),
          guestAccent: validColor(input.settings?.guestAccent, '#efbe9e'),
          background: validColor(input.settings?.background, '#101c24'),
          glowStrength: Math.max(.5, Math.min(1.8, Number(input.settings?.glowStrength) || 1)),
          paneWidth: Math.max(55, Math.min(72, Number(input.settings?.paneWidth) || 66)),
          layout: ['balanced','stage'].includes(input.settings?.layout) ? input.settings.layout : 'balanced'
        }, turns: [], events: []
      };
      await addEpisode(item); return json(res, 201, item);
    }
    if (parts[0] === 'api' && parts[1] === 'episodes' && parts[2]) {
      const item = episode(parts[2]); if (!item) return error(res, 404, 'Episode not found');
      if (parts.length === 3 && req.method === 'GET') return json(res, 200, item);
      if (parts[3] === 'events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        for (const event of item.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (!listeners.has(item.id)) listeners.set(item.id, new Set());
        listeners.get(item.id).add(res);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        req.on('close', () => { clearInterval(heartbeat); listeners.get(item.id)?.delete(res); });
        return;
      }
      if (parts[3] === 'start' && req.method === 'POST') {
        if (item.status !== 'draft') return error(res, 409, 'Episode has already started.');
        item.status = 'preparing'; await save();
        json(res, 202, { ok: true });
        setImmediate(() => runEpisode(item, publish, waitForAck));
        return;
      }
      if (parts[3] === 'ack' && req.method === 'POST') {
        const data = await body(req, 1000);
        const speech = item.events.find(event => event.id === data.eventId && event.type === 'speech');
        if (speech) { speech.acknowledged = true; await save(); }
        acknowledgements.get(`${item.id}:${data.eventId}`)?.();
        return json(res, 200, { ok: true });
      }
      if (parts[3] === 'stop' && req.method === 'POST') return json(res, 200, { stopped: stopEpisode(item.id) });
      if (parts[3] === 'video' && req.method === 'PUT') {
        const name = `${uid()}.webm`;
        const file = path.join(assets, name);
        let size = 0;
        req.on('data', chunk => { size += chunk.length; if (size > 1_000_000_000) req.destroy(new Error('Video too large')); });
        await pipeline(req, createWriteStream(file));
        item.video = `/assets/${name}`;
        const mp4Name = name.replace(/\.webm$/, '.mp4');
        if (item.settings.outputFormat !== 'webm' && await transcode(file, path.join(assets, mp4Name))) item.mp4 = `/assets/${mp4Name}`;
        await save();
        return json(res, 200, { video: item.video, mp4: item.mp4 || null });
      }
    }
    error(res, 404, 'Not found');
  } catch (cause) { error(res, 400, cause.message || 'Request failed'); }
});

const port = Number(process.env.PORT || 3377);
server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Live Podcast Studio: http://${process.env.HOST || '127.0.0.1'}:${port}`));
