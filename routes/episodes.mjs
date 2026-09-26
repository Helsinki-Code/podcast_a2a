import { listEpisodes, persona, episode, episodeEventsAfter, addEpisode, save, setEpisodeFields, acknowledgeEpisodeSpeech, assets, usesRemoteAssets, uid, stamp, reserveCredits, copyEpisodeForRestart, deleteEpisode } from '../lib/store.mjs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { costs } from '../lib/billing.mjs';
import { availableProviders, supportedVoice } from '../lib/providers.mjs';
import { stopEpisode } from '../lib/engine.mjs';
import { CAST_ROLES, DEFAULT_VOICES, DEFAULT_ACCENTS } from '../lib/cast.mjs';
import { assertPublicHttpUrl } from '../lib/url-security.mjs';
import { json, error, body } from '../lib/http.mjs';
import { listeners, acknowledgements, transcode, launchEpisode } from './live.mjs';

export async function handle({ req, res, url, parts, auth, userAccount }) {
  if (parts[0] === 'api' && parts[1] === 'episodes' && parts[2] && parts.length === 3 && req.method === 'DELETE') {
    const item = await episode(parts[2]);
    if (!item || item.ownerId !== auth.userId) return error(res, 404, 'Not found');
    if (['running','preparing'].includes(item.status) || item.videoStatus === 'processing') return error(res, 409, 'Stop it or wait for it to finish before deleting it.');
    return json(res, 200, { ok: true, filesRemoved: await deleteEpisode(item.id) });
  }
  if (url.pathname === '/api/episodes' && req.method === 'GET') return json(res, 200, (await listEpisodes(auth.userId)).map(({ events, ...rest }) => rest));
  if (url.pathname === '/api/episodes' && req.method === 'POST') {
    const input = await body(req);
    // Cast: host + guest are required; co-host and up to two more guests are optional.
    const castIds = { host: input.hostId, guest: input.guestId, cohost: input.cohostId, guest2: input.guest2Id, guest3: input.guest3Id };
    const cast = {};
    for (const role of CAST_ROLES) {
      const id = String(castIds[role] || '');
      if (!id) continue;
      const selected = await persona(id);
      if (!selected || selected.ownerId !== auth.userId) throw new Error(`Select a valid ${role === 'cohost' ? 'co-host' : role}.`);
      cast[role] = selected;
    }
    if (!cast.host || !cast.guest) throw new Error('Select a valid host and guest.');
    const castPersonaIds = Object.values(cast).map(entry => entry.id);
    if (new Set(castPersonaIds).size !== castPersonaIds.length) throw new Error('Each role needs a different persona.');
    const subject = String(input.outline?.subject || '').trim().slice(0, 200);
    if (!subject) throw new Error('The subject is required.');
    const validColor = (color, fallback) => /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
    const fullHD = Number(input.settings?.width) === 1920 && Number(input.settings?.height) === 1080;
    const demoUrl = String(input.settings?.demo?.url || '').trim().slice(0, 1000);
    if (demoUrl) await assertPublicHttpUrl(demoUrl);
    const authRequired = !!input.settings?.demo?.authRequired;
    const demoLoginUrl = String(input.settings?.demo?.loginUrl || '').trim().slice(0, 1000);
    if (demoLoginUrl) await assertPublicHttpUrl(demoLoginUrl);
    // Snapshot each persona into the episode and make sure no two cast members share a voice.
    const personas = {};
    const usedVoices = new Set();
    for (const role of CAST_ROLES) {
      if (!cast[role]) continue;
      const snapshot = structuredClone(cast[role]);
      const provider = snapshot.speechProvider || 'gateway';
      snapshot.voice = supportedVoice(provider, snapshot.voice, DEFAULT_VOICES[role]);
      if (usedVoices.has(`${provider}:${snapshot.voice}`)) snapshot.voice = (availableProviders().voices[provider] || []).find(voice => !usedVoices.has(`${provider}:${voice}`)) || snapshot.voice;
      usedVoices.add(`${provider}:${snapshot.voice}`);
      personas[role] = snapshot;
    }
    const accents = Object.fromEntries(CAST_ROLES.filter(role => personas[role]).map(role => [role, validColor(input.settings?.accents?.[role] || (role === 'host' ? input.settings?.accent : role === 'guest' ? input.settings?.guestAccent : ''), DEFAULT_ACCENTS[role])]));
    const music = input.settings?.music || {};
    const item = {
      id: uid(), ownerId: auth.userId, createdAt: stamp(), status: 'draft', hostId: cast.host.id, guestId: cast.guest.id,
      ...(cast.cohost ? { cohostId: cast.cohost.id } : {}), ...(cast.guest2 ? { guest2Id: cast.guest2.id } : {}), ...(cast.guest3 ? { guest3Id: cast.guest3.id } : {}),
      personas,
      outline: { subject, angle: String(input.outline?.angle || '').slice(0, 500), points: String(input.outline?.points || '').slice(0, 2500) },
      settings: {
        interjections: input.settings?.interjections !== false,
        interjectProbability: Math.max(0, Math.min(.25, Number(input.settings?.interjectProbability) || 0)),
        maxInterruptions: Math.max(0, Math.min(12, Number.isFinite(Number(input.settings?.maxInterruptions)) ? Number(input.settings.maxInterruptions) : 4)),
        targetMinutes: [0, 3, 5, 8, 12, 20, 30, 45].includes(Number(input.settings?.targetMinutes)) ? Number(input.settings.targetMinutes) : 0,
        accents,
        music: {
          intro: music.intro !== false, outro: music.outro !== false, bed: !!music.bed,
          volume: Math.max(0.02, Math.min(0.3, Number(music.volume) || 0.08)),
          track: /^\/assets\/[a-zA-Z0-9._-]+\.(mp3|wav|m4a|ogg)$/.test(String(music.track || '')) ? music.track : ''
        },
        hostTools: !!input.settings?.hostTools,
        requireGuestDemo: input.settings?.requireGuestDemo !== false,
        demo: {
          url: demoUrl,
          loginUrl: demoLoginUrl,
          brief: String(input.settings?.demo?.brief || '').trim().slice(0, 1500),
          authRequired,
          usernameSelector: String(input.settings?.demo?.usernameSelector || 'input[type="email"], input[autocomplete="username"], input[autocomplete="email"], input[name*="email" i], input[name*="user" i], input[id*="email" i], input[id*="user" i]').slice(0, 600),
          passwordSelector: String(input.settings?.demo?.passwordSelector || 'input[type="password"], input[autocomplete="current-password"]').slice(0, 400),
          submitSelector: String(input.settings?.demo?.submitSelector || 'button[type="submit"], input[type="submit"], button[name*="login" i], button[name*="sign" i]').slice(0, 400)
        },
        maxMinutes: Math.max(1, Math.min(180, Number(input.settings?.maxMinutes) || 30)),
        width: fullHD ? 1920 : 1280,
        height: fullHD ? 1080 : 720,
        outputFormat: ['both','mp4','webm'].includes(input.settings?.outputFormat) ? input.settings.outputFormat : 'both',
        captionStyle: ['studio','minimal','bold'].includes(input.settings?.captionStyle) ? input.settings.captionStyle : 'studio',
        accent: accents.host,
        guestAccent: accents.guest,
        background: validColor(input.settings?.background, '#101c24'),
        glowStrength: Math.max(.5, Math.min(1.8, Number(input.settings?.glowStrength) || 1)),
        paneWidth: Math.max(55, Math.min(72, Number(input.settings?.paneWidth) || 66)),
        layout: ['balanced','stage'].includes(input.settings?.layout) ? input.settings.layout : 'balanced',
        playbackMode: input.settings?.playbackMode === 'background' ? 'background' : 'live',
        captionOptions: {
          enabled: input.settings?.captionOptions?.enabled !== false,
          font: ['sans','serif','mono'].includes(input.settings?.captionOptions?.font) ? input.settings.captionOptions.font : 'sans',
          size: Math.max(10, Math.min(24, Number(input.settings?.captionOptions?.size) || 13)),
          position: ['bottom','center','top'].includes(input.settings?.captionOptions?.position) ? input.settings.captionOptions.position : 'bottom',
          wordsPerCue: Math.max(3, Math.min(10, Number(input.settings?.captionOptions?.wordsPerCue) || 7))
        }
      }, turns: [], events: []
    };
    await addEpisode(item); return json(res, 201, item);
  }
  if (parts[0] === 'api' && parts[1] === 'episodes' && parts[2]) {
    const item = await episode(parts[2]); if (!item || item.ownerId !== auth.userId) return error(res, 404, 'Episode not found');
    if (parts.length === 3 && req.method === 'GET') return json(res, 200, item);
    // Incremental JSON feed: only events after the client's cursor, plus the fields the studio renders.
    if (parts[3] === 'events' && req.method === 'GET' && url.searchParams.get('format') === 'json') {
      const after = Number(url.searchParams.get('after')) || 0;
      const events = await episodeEventsAfter(item.id, after);
      const { turns: _turns, events: _events, personas: _personas, ...fields } = item;
      return json(res, 200, { events, cursor: events.at(-1)?.seq || after, episode: fields });
    }
    if (parts[3] === 'events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      for (const event of item.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (!listeners.has(item.id)) listeners.set(item.id, new Set());
      listeners.get(item.id).add(res);
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
      req.on('close', () => { clearInterval(heartbeat); listeners.get(item.id)?.delete(res); });
      return true;
    }
    if (parts.length === 3 && req.method === 'PATCH') {
      const title = String((await body(req, 4000)).title ?? '').trim().slice(0, 200);
      if (!title) return error(res, 400, 'Enter a title.');
      await setEpisodeFields(item.id, { title });
      return json(res, 200, { ok: true, title });
    }
    if (parts[3] === 'duplicate' && req.method === 'POST') {
      if (['running','preparing'].includes(item.status)) return error(res, 409, 'Wait for this episode to finish before duplicating it.');
      const copy = await copyEpisodeForRestart({ ...item, ...(item.title ? { title: `${item.title} (copy)` } : {}) });
      return json(res, 201, copy);
    }
    if (parts[3] === 'restart' && req.method === 'POST') {
      if (!['complete','stopped','failed','interrupted'].includes(item.status)) return error(res, 409, 'Stop or finish this episode before restarting it.');
      const restarted = await copyEpisodeForRestart(item);
      return json(res, 201, restarted);
    }
    if (parts[3] === 'start' && req.method === 'POST') {
      if (item.status !== 'draft') return error(res, 409, 'Episode has already started.');
      if (item.settings.demo?.authRequired && !item.demoPrepared) return error(res, 409, 'Prepare the authenticated browser before recording.');
      if (!await reserveCredits(auth.userId, costs.podcast, 'podcast', item.id)) return error(res, 402, `This podcast needs ${costs.podcast} credits.`);
      await setEpisodeFields(item.id, { status: 'preparing', stopRequested: false, creditsCharged: costs.podcast, creditReference: item.id, attempt: 1 });
      return launchEpisode(res, item);
    }
    // Continue a failed or interrupted conversation from its last turn instead of starting over.
    if (parts[3] === 'resume' && req.method === 'POST') {
      if (!['failed','interrupted'].includes(item.status)) return error(res, 409, 'Only a failed or interrupted episode can be resumed.');
      if (!item.turns?.length) return error(res, 409, 'Nothing was recorded yet. Restart the episode instead.');
      if (item.settings.demo?.authRequired && !item.guestDemoDone) {
        const input = await body(req, 12000);
        const credentials = { username: String(input.credentials?.username || '').slice(0, 500), password: String(input.credentials?.password || '').slice(0, 2000) };
        if (!credentials.username || !credentials.password) return error(res, 400, 'Sign in to the demo platform again so the guest can finish the demonstration.');
        const { VercelEpisodeSandbox } = await import('../lib/vercel-sandbox.mjs');
        await new VercelEpisodeSandbox(item.id, () => {}).login(item.settings.demo, credentials);
      }
      const attempt = (Number(item.attempt) || 1) + 1;
      const reference = `${item.id}:attempt-${attempt}`;
      if (!await reserveCredits(auth.userId, costs.podcast, 'podcast', reference)) return error(res, 402, `Resuming this podcast needs ${costs.podcast} credits.`);
      await setEpisodeFields(item.id, { status: 'preparing', stopRequested: false, error: null, creditsCharged: costs.podcast, creditReference: reference, attempt, videoStatus: null, videoError: null });
      return launchEpisode(res, item);
    }
    // Re-run only the MP4 assembly when the conversation finished but its video failed.
    if (parts[3] === 'render' && req.method === 'POST') {
      if (!['complete','stopped'].includes(item.status) || item.videoStatus !== 'failed') return error(res, 409, 'Only a finished episode whose video failed can be rendered again.');
      if (!process.env.VERCEL) return error(res, 409, 'Local episodes are recorded in the browser; restart the episode to record a new take.');
      const attempt = (Number(item.renderAttempt) || 0) + 1;
      const reference = `${item.id}:render-${attempt}`;
      if (!await reserveCredits(auth.userId, costs.podcast, 'podcast', reference)) return error(res, 402, `Rendering this podcast needs ${costs.podcast} credits.`);
      await setEpisodeFields(item.id, { videoStatus: 'processing', videoError: null, creditsCharged: costs.podcast, creditReference: reference, renderAttempt: attempt });
      const [{ start }, { podcastRenderWorkflow }] = await Promise.all([import('workflow/api'), import('../workflows/podcast-render.mjs')]);
      const run = await start(podcastRenderWorkflow, [item.id]);
      await setEpisodeFields(item.id, { videoWorkflowRunId: run.runId });
      return json(res, 202, { ok: true, runId: run.runId });
    }
    if (parts[3] === 'prepare' && req.method === 'POST') {
      if (item.status !== 'draft') return error(res, 409, 'Only a draft episode can prepare its browser.');
      if (!item.settings.demo?.authRequired) return json(res, 200, { ok: true });
      const input = await body(req, 12000);
      const credentials = { username: String(input.credentials?.username || '').slice(0, 500), password: String(input.credentials?.password || '').slice(0, 2000) };
      if (!credentials.username || !credentials.password) return error(res, 400, 'Login username and password are required for this platform demo.');
      const { VercelEpisodeSandbox } = await import('../lib/vercel-sandbox.mjs');
      await new VercelEpisodeSandbox(item.id, () => {}).login(item.settings.demo, credentials);
      await setEpisodeFields(item.id, { demoPrepared: true });
      return json(res, 200, { ok: true });
    }
    if (parts[3] === 'desktop' && req.method === 'GET') {
      if (item.status !== 'draft') return error(res, 409, 'The secure desktop is available while the episode is a draft.');
      const { VercelEpisodeSandbox } = await import('../lib/vercel-sandbox.mjs');
      const liveUrl = await new VercelEpisodeSandbox(item.id, () => {}).interactiveDesktop(item.settings.demo?.loginUrl || item.settings.demo?.url);
      if (!liveUrl) return error(res, 409, 'The visible Computer Use desktop is not configured.');
      return json(res, 200, { liveUrl });
    }
    if (parts[3] === 'desktop-ready' && req.method === 'POST') {
      if (item.status !== 'draft' || !item.settings.demo?.authRequired) return error(res, 409, 'This episode does not need manual browser preparation.');
      const { VercelEpisodeSandbox } = await import('../lib/vercel-sandbox.mjs');
      const screen = await new VercelEpisodeSandbox(item.id, () => {}).capture(null, item.settings.demo.url);
      await setEpisodeFields(item.id, { demoPrepared: true, manualDesktopPrepared: true });
      return json(res, 200, { ok: true, screen: { title: screen.title, image: screen.image } });
    }
    if (parts[3] === 'ack' && req.method === 'POST') {
      const data = await body(req, 1000);
      const speech = item.events.find(event => event.id === data.eventId && event.type === 'speech');
      if (speech) await acknowledgeEpisodeSpeech(item.id, data.eventId);
      if (process.env.VERCEL && speech) {
        const { playbackHook, playbackToken } = await import('../workflows/episode.mjs');
        try { await playbackHook.resume(playbackToken(item.id, data.eventId), { played: true }); } catch (cause) {
          if (!/not found|already|completed/i.test(cause.message)) throw cause;
        }
      } else acknowledgements.get(`${item.id}:${data.eventId}`)?.();
      return json(res, 200, { ok: true });
    }
    if (parts[3] === 'stop' && req.method === 'POST') {
      if (process.env.VERCEL) {
        await setEpisodeFields(item.id, { stopRequested: true, status: 'stopped', endedAt: stamp() });
        const pending = [...item.events].reverse().find(event => event.type === 'speech' && !event.acknowledged);
        if (pending) {
          const { playbackHook, playbackToken } = await import('../workflows/episode.mjs');
          try { await playbackHook.resume(playbackToken(item.id, pending.id), { stopped: true }); } catch {}
        }
        return json(res, 200, { stopped: true });
      }
      return json(res, 200, { stopped: await stopEpisode(item.id) });
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
      item.videoStatus = item.settings.outputFormat === 'webm' ? 'complete' : 'processing';
      await save(item);
      if (item.settings.outputFormat !== 'webm') {
        const [{ start }, { podcastVideoWorkflow }] = await Promise.all([import('workflow/api'), import('../workflows/podcast-video.mjs')]);
        const run = await start(podcastVideoWorkflow, [item.id, pathname]);
        await setEpisodeFields(item.id, { videoWorkflowRunId: run.runId });
      }
      return json(res, 200, { video: item.video, mp4: null, videoStatus: item.videoStatus });
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
  return false;
}
