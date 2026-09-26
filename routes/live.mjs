import { spawn } from 'node:child_process';
import { episode, setEpisodeFields, appendEpisodeEvent, refundCredits, uid, stamp } from '../lib/store.mjs';
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
    const [{ start }, { episodeWorkflow }] = await Promise.all([import('workflow/api'), import('../workflows/episode.mjs')]);
    const run = await start(episodeWorkflow, [item.id]);
    await setEpisodeFields(item.id, { workflowRunId: run.runId });
    return json(res, 202, { ok: true, runId: run.runId });
  }
  json(res, 202, { ok: true });
  setImmediate(async () => runEpisode(await episode(item.id), publish, waitForAck).catch(console.error));
  return true;
}

// A workflow run can die outside the episode's own error handling (a platform limit, a replay
// error, a cancelled run). The episode would then sit at "Starting" forever, so the live feed
// checks the run now and then and fails the episode with the run's own reason.
const lastRunCheck = new Map();
export async function reconcileEpisodeRun(item) {
  if (!process.env.VERCEL || !item?.workflowRunId || !['preparing', 'running'].includes(item.status)) return false;
  const now = Date.now();
  if (now - (lastRunCheck.get(item.id) || 0) < 15000) return false;
  lastRunCheck.set(item.id, now);
  let status, reason = '';
  try {
    const { getRun } = await import('workflow/api');
    const run = getRun(item.workflowRunId);
    status = await run.status;
    if (status === 'failed') await run.returnValue.catch(cause => { reason = String(cause?.message || cause || '').slice(0, 600); });
  } catch { return false; }
  if (!['failed', 'cancelled', 'completed'].includes(status)) return false;
  const fresh = await episode(item.id);
  if (!fresh || !['preparing', 'running'].includes(fresh.status)) return false;
  const error = status === 'failed'
    ? `The recording workflow failed${reason ? `: ${reason}` : '.'}`
    : `The recording workflow ${status === 'cancelled' ? 'was cancelled' : 'ended'} before the episode finished.`;
  if (fresh.creditsCharged && fresh.ownerId) await refundCredits(fresh.ownerId, fresh.creditsCharged, 'podcast', fresh.creditReference || fresh.id).catch(() => {});
  await setEpisodeFields(fresh.id, { status: 'failed', error, endedAt: stamp(), creditsCharged: 0 });
  await appendEpisodeEvent(fresh.id, { id: uid(), at: stamp(), type: 'status', status: 'failed', error });
  return true;
}
