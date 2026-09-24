import './lib/env.mjs';
import http from 'node:http';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initStore, listPersonas, listEpisodes, persona, episode, addPersona, updatePersona, deletePersona, addEpisode, putAsset, save, setEpisodeFields, acknowledgeEpisodeSpeech, assets, usesRemoteAssets, uid, stamp, account, reserveCredits, listExplainers, explainer, saveExplainer, setExplainerFields, assetOwnedBy } from './lib/store.mjs';
import { authenticate, primaryEmail } from './lib/auth.mjs';
import { costs, createCheckout, createPortal, isPaid, processStripeWebhook, publicPlans } from './lib/billing.mjs';
import { availableProviders } from './lib/providers.mjs';
import { runEpisode, stopEpisode } from './lib/engine.mjs';
import { openLiveAudio } from './lib/audio.mjs';
import { buildIndex } from './lib/rag.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let initialization;
function ensureInitialized() {
  initialization ||= (async () => {
    await initStore();
    await import('./plugins/index.mjs');
  })();
  return initialization;
}
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
async function cleanPersona(input) {
  const name = String(input.name || '').trim().slice(0, 80);
  const systemPrompt = String(input.systemPrompt || '').trim().slice(0, 12000);
  if (!name || !systemPrompt) throw new Error('Persona name and system prompt are required.');
  const knowledge = (Array.isArray(input.knowledge) ? input.knowledge : []).slice(0, 20).map(k => ({ name: String(k.name || 'notes.txt').slice(0, 100), text: String(k.text || '').slice(0, 250000) }));
  let image = String(input.image || '');
  if (image.startsWith('data:')) {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(image);
    if (!match) throw new Error('Upload a PNG, JPEG, or WebP display image.');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > 3_000_000) throw new Error('Display images must be under 3 MB.');
    image = await putAsset(`persona.${match[1] === 'jpeg' ? 'jpg' : match[1]}`, bytes);
  } else if (image && !/^\/assets\/[a-zA-Z0-9._-]+$/.test(image)) throw new Error('Invalid display image path.');
  return { name, systemPrompt, knowledge, knowledgeIndex: buildIndex(knowledge), image, modelProvider: String(input.modelProvider || 'gateway'), model: String(input.model || '').slice(0, 80), speechProvider: String(input.speechProvider || (process.env.OPENAI_API_KEY ? 'openai' : 'gateway')), voice: String(input.voice || 'alloy').slice(0, 100) };
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
async function assetFile(req, res, filename) {
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
}

export async function handler(req, res) {
  try {
    await ensureInitialized();
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { ok: true });
    if (url.pathname === '/api/webhooks/stripe' && req.method === 'POST') {
      const raw = await rawBody(req, 2_000_000);
      return json(res, 200, await processStripeWebhook(raw, req.headers['stripe-signature'] || ''));
    }
    if (url.pathname === '/' && req.method === 'GET') return staticFile(req, res, path.join(here, 'public'), 'index.html');
    if (url.pathname === '/privacy' && req.method === 'GET') return staticFile(req, res, path.join(here, 'public'), 'privacy.html');
    if (url.pathname === '/terms' && req.method === 'GET') return staticFile(req, res, path.join(here, 'public'), 'terms.html');
    if (parts[0] === 'public' && req.method === 'GET') return staticFile(req, res, path.join(here, 'public'), parts.slice(1).join('/'));
    if (url.pathname === '/api/config' && req.method === 'GET') {
      const providers = availableProviders();
      return json(res, 200, { brand: 'The Sales Forge', clerkPublishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || '', plans: publicPlans(), costs, providers, storage: { remoteAssets: usesRemoteAssets() }, realtime: process.env.VERCEL ? 'poll' : 'sse', ready: { model: Object.values(providers.ready.models).some(Boolean), sandbox: !!(process.env.VERCEL || process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL_TOKEN) } });
    }
    const auth = await authenticate(req);
    if (!auth) return error(res, 401, 'Sign in to The Sales Forge.');
    const userAccount = await account(auth.userId);
    if (url.pathname === '/api/auth/me' && req.method === 'GET') {
      const email = await primaryEmail(auth.userId);
      return json(res, 200, { userId: auth.userId, email, account: await account(auth.userId, email), costs });
    }
    if (url.pathname === '/api/billing/checkout' && req.method === 'POST') {
      const input = await body(req, 5000);
      return json(res, 200, { url: await createCheckout(auth.userId, await primaryEmail(auth.userId), String(input.plan || '')) });
    }
    if (url.pathname === '/api/billing/portal' && req.method === 'POST') return json(res, 200, { url: await createPortal(auth.userId) });
    if (!isPaid(userAccount)) return error(res, 402, 'A paid The Sales Forge subscription is required.');
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
      if (openLiveAudio(id, req, res)) return;
      return assetFile(req, res, `${id}.mp3`);
    }
    if (parts[0] === 'assets' && req.method === 'GET') { const filename = parts.slice(1).join('/'); if (!await assetOwnedBy(auth.userId, filename)) return error(res, 404, 'Asset not found'); return assetFile(req, res, filename); }
    if (parts[0] === 'api' && parts[1] === '_assets' && req.method === 'GET') { const filename = parts.slice(2).join('/'); if (!await assetOwnedBy(auth.userId, filename)) return error(res, 404, 'Asset not found'); return assetFile(req, res, filename); }
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
    if (url.pathname === '/api/personas' && req.method === 'GET') return json(res, 200, await listPersonas(auth.userId));
    if (url.pathname === '/api/personas' && req.method === 'POST') {
      const input = await cleanPersona(await body(req));
      const item = { ...input, id: uid(), ownerId: auth.userId, createdAt: stamp() };
      await addPersona(item); return json(res, 201, item);
    }
    if (parts[0] === 'api' && parts[1] === 'personas' && parts[2] && req.method === 'PUT') {
      const existing = await persona(parts[2]);
      if (!existing || existing.ownerId !== auth.userId) return error(res, 404, 'Persona not found');
      const item = await updatePersona(parts[2], await cleanPersona(await body(req)));
      return item ? json(res, 200, item) : error(res, 404, 'Persona not found');
    }
    if (parts[0] === 'api' && parts[1] === 'personas' && parts[2] && req.method === 'DELETE') {
      const existing = await persona(parts[2]);
      if (!existing || existing.ownerId !== auth.userId) return error(res, 404, 'Persona not found');
      await deletePersona(parts[2]); return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/episodes' && req.method === 'GET') return json(res, 200, (await listEpisodes(auth.userId)).map(({ events, ...rest }) => rest));
    if (url.pathname === '/api/episodes' && req.method === 'POST') {
      const input = await body(req);
      const hostPersona = await persona(input.hostId), guestPersona = await persona(input.guestId);
      if (!hostPersona || !guestPersona || hostPersona.ownerId !== auth.userId || guestPersona.ownerId !== auth.userId) throw new Error('Select a valid host and guest.');
      if (input.hostId === input.guestId) throw new Error('Host and guest must be different personas.');
      const subject = String(input.outline?.subject || '').trim().slice(0, 200);
      if (!subject) throw new Error('The subject is required.');
      const validColor = (color, fallback) => /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
      const fullHD = Number(input.settings?.width) === 1920 && Number(input.settings?.height) === 1080;
      const demoUrl = String(input.settings?.demo?.url || '').trim().slice(0, 1000);
      if (demoUrl && !/^https?:\/\//i.test(demoUrl)) throw new Error('The demo URL must begin with http:// or https://.');
      const authRequired = !!input.settings?.demo?.authRequired;
      const item = {
        id: uid(), ownerId: auth.userId, createdAt: stamp(), status: 'draft', hostId: input.hostId, guestId: input.guestId,
        personas: { host: structuredClone(hostPersona), guest: structuredClone(guestPersona) },
        outline: { subject, angle: String(input.outline?.angle || '').slice(0, 500), points: String(input.outline?.points || '').slice(0, 2500) },
        settings: {
          interjections: input.settings?.interjections !== false,
          interjectProbability: Math.max(0, Math.min(.25, Number(input.settings?.interjectProbability) || 0)),
          hostTools: !!input.settings?.hostTools,
          requireGuestDemo: input.settings?.requireGuestDemo !== false,
          demo: {
            url: demoUrl,
            brief: String(input.settings?.demo?.brief || '').trim().slice(0, 1500),
            authRequired,
            usernameSelector: String(input.settings?.demo?.usernameSelector || 'input[type="email"], input[name="email"], input[name="username"]').slice(0, 300),
            passwordSelector: String(input.settings?.demo?.passwordSelector || 'input[type="password"]').slice(0, 300),
            submitSelector: String(input.settings?.demo?.submitSelector || 'button[type="submit"], input[type="submit"]').slice(0, 300)
          },
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
      const item = await episode(parts[2]); if (!item || item.ownerId !== auth.userId) return error(res, 404, 'Episode not found');
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
        if (item.settings.demo?.authRequired && !item.demoPrepared) return error(res, 409, 'Prepare the authenticated browser before recording.');
        if (!await reserveCredits(auth.userId, costs.podcast, 'podcast', item.id)) return error(res, 402, `This podcast needs ${costs.podcast} credits.`);
        await setEpisodeFields(item.id, { status: 'preparing', stopRequested: false, creditsCharged: costs.podcast });
        if (process.env.VERCEL) {
          const [{ start }, { episodeWorkflow }] = await Promise.all([import('workflow/api'), import('./workflows/episode.mjs')]);
          const run = await start(episodeWorkflow, [item.id, { demo: item.settings.demo || {}, prepared: !!item.demoPrepared }]);
          await setEpisodeFields(item.id, { workflowRunId: run.runId });
          return json(res, 202, { ok: true, runId: run.runId });
        }
        json(res, 202, { ok: true });
        setImmediate(() => runEpisode(item, publish, waitForAck));
        return;
      }
      if (parts[3] === 'prepare' && req.method === 'POST') {
        if (item.status !== 'draft') return error(res, 409, 'Only a draft episode can prepare its browser.');
        if (!item.settings.demo?.authRequired) return json(res, 200, { ok: true });
        const input = await body(req, 12000);
        const credentials = { username: String(input.credentials?.username || '').slice(0, 500), password: String(input.credentials?.password || '').slice(0, 2000) };
        if (!credentials.username || !credentials.password) return error(res, 400, 'Login username and password are required for this platform demo.');
        const { VercelEpisodeSandbox } = await import('./lib/vercel-sandbox.mjs');
        await new VercelEpisodeSandbox(item.id, () => {}).login(item.settings.demo, credentials);
        await setEpisodeFields(item.id, { demoPrepared: true });
        return json(res, 200, { ok: true });
      }
      if (parts[3] === 'ack' && req.method === 'POST') {
        const data = await body(req, 1000);
        const speech = item.events.find(event => event.id === data.eventId && event.type === 'speech');
        if (speech) await acknowledgeEpisodeSpeech(item.id, data.eventId);
        if (process.env.VERCEL && speech) {
          const { playbackHook, playbackToken } = await import('./workflows/episode.mjs');
          try { await playbackHook.resume(playbackToken(item.id, data.eventId), { played: true }); } catch (cause) {
            if (!/not found|already|completed/i.test(cause.message)) throw cause;
          }
        } else acknowledgements.get(`${item.id}:${data.eventId}`)?.();
        return json(res, 200, { ok: true });
      }
      if (parts[3] === 'stop' && req.method === 'POST') {
        if (process.env.VERCEL) {
          await setEpisodeFields(item.id, { stopRequested: true });
          const pending = [...item.events].reverse().find(event => event.type === 'speech' && !event.acknowledged);
          if (pending) {
            const { playbackHook, playbackToken } = await import('./workflows/episode.mjs');
            try { await playbackHook.resume(playbackToken(item.id, pending.id), { stopped: true }); } catch {}
          }
          return json(res, 200, { stopped: true });
        }
        return json(res, 200, { stopped: stopEpisode(item.id) });
      }
      if (parts[3] === 'video' && parts[4] === 'complete' && req.method === 'POST') {
        if (!usesRemoteAssets()) return error(res, 409, 'Direct Blob upload is not enabled.');
        const pathname = String((await body(req, 1000)).pathname || '');
        const filename = pathname.startsWith('assets/') ? pathname.slice(7) : '';
        if (!new RegExp(`^episode-${item.id}-[a-f0-9-]{36}\\.webm$`, 'i').test(filename)) return error(res, 400, 'Invalid episode video path.');
        const { head } = await import('@vercel/blob');
        const blob = await head(pathname);
        if (!blob || blob.pathname !== pathname) return error(res, 404, 'Video upload not found.');
        item.video = `/assets/${filename}`;
        await save(item);
        return json(res, 200, { video: item.video, mp4: null });
      }
      if (parts[3] === 'video' && req.method === 'PUT') {
        if (usesRemoteAssets()) return error(res, 409, 'Use direct Blob upload for videos.');
        const name = `${uid()}.webm`;
        const file = path.join(assets, name);
        let size = 0;
        req.on('data', chunk => { size += chunk.length; if (size > 1_000_000_000) req.destroy(new Error('Video too large')); });
        await pipeline(req, createWriteStream(file));
        item.video = `/assets/${name}`;
        const mp4Name = name.replace(/\.webm$/, '.mp4');
        if (item.settings.outputFormat !== 'webm' && await transcode(file, path.join(assets, mp4Name))) item.mp4 = `/assets/${mp4Name}`;
        await save(item);
        return json(res, 200, { video: item.video, mp4: item.mp4 || null });
      }
    }
    if (url.pathname === '/api/explainers' && req.method === 'GET') return json(res, 200, await listExplainers(auth.userId));
    if (url.pathname === '/api/explainers' && req.method === 'POST') {
      const input = await body(req, 20_000);
      const targetUrl = String(input.url || '').trim().slice(0, 1200);
      const brief = String(input.brief || '').trim().slice(0, 3000);
      const loginUrl = String(input.loginUrl || '').trim().slice(0, 1200);
      if (!/^https?:\/\//i.test(targetUrl)) return error(res, 400, 'Enter an application URL beginning with http:// or https://.');
      if (loginUrl && !/^https?:\/\//i.test(loginUrl)) return error(res, 400, 'The login page URL must begin with http:// or https://.');
      if (brief.length < 20) return error(res, 400, 'Describe the workflow the video should explain.');
      const item = {
        id: uid(), ownerId: auth.userId, createdAt: stamp(), status: 'draft', url: targetUrl, brief,
        title: String(input.title || new URL(targetUrl).hostname).trim().slice(0, 120),
        authRequired: !!input.authRequired,
        loginUrl,
        usernameSelector: String(input.usernameSelector || 'input[type="email"], input[autocomplete="username"], input[autocomplete="email"], input[name*="email" i], input[name*="user" i], input[id*="email" i], input[id*="user" i]').slice(0, 600),
        passwordSelector: String(input.passwordSelector || 'input[type="password"], input[autocomplete="current-password"]').slice(0, 400),
        submitSelector: String(input.submitSelector || 'button[type="submit"], input[type="submit"], button[name*="login" i], button[name*="sign" i]').slice(0, 400),
        speechProvider: String(input.speechProvider || 'gateway').slice(0, 40), voice: String(input.voice || 'marin').slice(0, 100)
      };
      await saveExplainer(item); return json(res, 201, item);
    }
    if (parts[0] === 'api' && parts[1] === 'explainers' && parts[2]) {
      const item = await explainer(parts[2]);
      if (!item || item.ownerId !== auth.userId) return error(res, 404, 'Explainer not found');
      if (parts.length === 3 && req.method === 'GET') return json(res, 200, item);
      if (parts[3] === 'prepare' && req.method === 'POST') {
        if (item.status !== 'draft') return error(res, 409, 'Only a draft explainer can prepare its browser.');
        if (!item.authRequired) return json(res, 200, { ok: true });
        const input = await body(req, 12_000);
        const credentials = { username: String(input.username || '').slice(0, 500), password: String(input.password || '').slice(0, 2000) };
        if (!credentials.username || !credentials.password) return error(res, 400, 'Login username and password are required.');
        const loginUrl = String(input.loginUrl || item.loginUrl || '').trim().slice(0, 1200);
        if (loginUrl && !/^https?:\/\//i.test(loginUrl)) return error(res, 400, 'The login page URL must begin with http:// or https://.');
        const login = {
          url: item.url,
          loginUrl,
          authRequired: true,
          usernameSelector: String(input.usernameSelector || item.usernameSelector || '').slice(0, 600),
          passwordSelector: String(input.passwordSelector || item.passwordSelector || '').slice(0, 400),
          submitSelector: String(input.submitSelector || item.submitSelector || '').slice(0, 400)
        };
        const { VercelEpisodeSandbox } = await import('./lib/vercel-sandbox.mjs');
        await new VercelEpisodeSandbox(item.id, () => {}).login(login, credentials);
        await setExplainerFields(item.id, { ...login, browserPrepared: true, progress: 'Secure browser prepared', error: null });
        return json(res, 200, { ok: true });
      }
      if (parts[3] === 'start' && req.method === 'POST') {
        if (item.status !== 'draft') return error(res, 409, 'This explainer has already started.');
        if (item.authRequired && !item.browserPrepared) return error(res, 409, 'Prepare the authenticated browser first.');
        if (!await reserveCredits(auth.userId, costs.explainer, 'explainer', item.id)) return error(res, 402, `This explainer needs ${costs.explainer} credits.`);
        await setExplainerFields(item.id, { status: 'queued', progress: 'Queued', creditsCharged: costs.explainer });
        const { explainerWorkflow } = await import('./workflows/explainer.mjs');
        if (process.env.VERCEL) {
          const { start } = await import('workflow/api');
          const run = await start(explainerWorkflow, [item.id]);
          await setExplainerFields(item.id, { workflowRunId: run.runId });
          return json(res, 202, { ok: true, runId: run.runId });
        }
        json(res, 202, { ok: true });
        setImmediate(() => explainerWorkflow(item.id));
        return;
      }
    }
    error(res, 404, 'Not found');
  } catch (cause) { error(res, 400, cause.message || 'Request failed'); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3377);
  http.createServer(handler).listen(port, process.env.HOST || '127.0.0.1', () => console.log(`The Sales Forge: http://${process.env.HOST || '127.0.0.1'}:${port}`));
}
