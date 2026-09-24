import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { assets, uid, putNamedAsset, usesRemoteAssets } from './store.mjs';

const live = new Map();

export function startSpeech(provider, text, voice) {
  const id = uid();
  const file = path.join(assets, `${id}.mp3`);
  const state = { chunks: [], clients: new Set(), complete: false, error: null };
  live.set(id, state);
  const done = (async () => {
    const output = usesRemoteAssets() ? null : createWriteStream(file);
    try {
      const value = await provider.synthesize(text, voice);
      const stream = Buffer.isBuffer(value) || value instanceof Uint8Array ? [value] : value;
      for await (const part of stream) {
        const chunk = Buffer.from(part);
        if (!chunk.length) continue;
        state.chunks.push(chunk);
        output?.write(chunk);
        for (const client of state.clients) client.write(chunk);
      }
      if (output) await new Promise((resolve, reject) => { output.once('error', reject); output.end(resolve); });
      else await putNamedAsset(`${id}.mp3`, Buffer.concat(state.chunks));
      state.complete = true;
      for (const client of state.clients) client.end();
      state.clients.clear();
    } catch (error) {
      state.error = error;
      output?.destroy();
      for (const client of state.clients) client.destroy(error);
      state.clients.clear();
      throw error;
    } finally { setTimeout(() => live.delete(id), 5 * 60 * 1000).unref(); }
  })();
  done.catch(() => {});
  return { id, url: `/api/audio/${id}`, done };
}

export function openLiveAudio(id, req, res) {
  const state = live.get(id);
  if (!state) return false;
  if (state.error) { res.writeHead(502); res.end(state.error.message); return true; }
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  for (const chunk of state.chunks) res.write(chunk);
  if (state.complete) res.end();
  else { state.clients.add(res); req.on('close', () => state.clients.delete(res)); }
  return true;
}
