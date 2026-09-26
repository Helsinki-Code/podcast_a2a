import { spawn } from 'node:child_process';
import { episode, setEpisodeFields } from '../lib/store.mjs';
import { runEpisode } from '../lib/engine.mjs';
import { json } from '../lib/http.mjs';

// Local-server runtime: live event streams, playback acknowledgements, and episode launch.
// On Vercel, durable workflows replace the in-process parts.
export const listeners = new Map();
export const acknowledgements = new Map();
export async function transcode(input, output) {
  return new Promise(resolve => {
    const proc = spawn('ffmpeg', ['-y','-i',input,'-c:v','libx264','-preset','veryfast','-crf','22','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',output], { stdio: 'ignore' });
    proc.on('error', () => resolve(false)); proc.on('exit', code => resolve(code === 0));
  });
}
export function publish(id, event) {
  for (const res of listeners.get(id) || []) res.write(`data: ${JSON.stringify(event)}\n\n`);
}
export function waitForAck(id, eventId, isStopped) {
  return new Promise((resolve, reject) => {
    const key = `${id}:${eventId}`;
    const timeout = setTimeout(() => { acknowledgements.delete(key); reject(new Error('Playback client disconnected or did not acknowledge speech.')); }, 180000);
    const interval = setInterval(() => { if (isStopped()) { clearTimeout(timeout); clearInterval(interval); acknowledgements.delete(key); resolve(); } }, 500);
    acknowledgements.set(key, () => { clearTimeout(timeout); clearInterval(interval); acknowledgements.delete(key); resolve(); });
  });
}
export async function launchEpisode(res, item) {
  if (process.env.VERCEL) {
    const [{ start }, { episodeWorkflow }] = await Promise.all([import('workflow/api'), import('./workflows/episode.mjs')]);
    const run = await start(episodeWorkflow, [item.id]);
    await setEpisodeFields(item.id, { workflowRunId: run.runId });
    return json(res, 202, { ok: true, runId: run.runId });
  }
  json(res, 202, { ok: true });
  setImmediate(async () => runEpisode(await episode(item.id), publish, waitForAck).catch(console.error));
  return true;
}
// Knowledge is re-embedded only when its content changes.
