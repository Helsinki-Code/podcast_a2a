import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// A podcast whose durable run died outside its own error handling must not sit at "Starting"
// forever: the live feed notices the dead run and fails the episode with the run's reason.
const temp = await mkdtemp(path.join(os.tmpdir(), 'workflow-reconcile-'));
process.chdir(temp);
delete process.env.DATABASE_URL;
const runs = new Map();
mock.module('workflow/api', { namedExports: {
  getRun: runId => {
    const run = runs.get(runId);
    return { status: Promise.resolve(run.status), returnValue: run.status === 'failed' ? Promise.reject(new Error(run.error)) : Promise.resolve(null) };
  }
} });
const store = await import('../lib/store.mjs');
const { reconcileEpisodeRun } = await import('../routes/live.mjs');
await store.initStore();

const addRunningEpisode = async (id, runId) => {
  await store.addEpisode({ id, ownerId: 'owner', status: 'running', workflowRunId: runId, creditsCharged: 0, settings: {}, outline: { subject: 'x' }, personas: {}, turns: [], events: [] });
  return store.episode(id);
};

test('a failed workflow run fails its episode with the run error', async () => {
  process.env.VERCEL = '1';
  try {
    runs.set('run-failed', { status: 'failed', error: 'Step output exceeded the size limit.' });
    runs.set('run-live', { status: 'running' });
    assert.equal(await reconcileEpisodeRun(await addRunningEpisode('ep-live', 'run-live')), false);
    assert.equal((await store.episode('ep-live')).status, 'running');
    assert.equal(await reconcileEpisodeRun(await addRunningEpisode('ep-dead', 'run-failed')), true);
    const item = await store.episode('ep-dead');
    assert.equal(item.status, 'failed');
    assert.match(item.error, /size limit/);
    assert.equal(item.events.at(-1).type, 'status');
    assert.equal(item.events.at(-1).status, 'failed');
    // Checked at most every 15 seconds per episode.
    assert.equal(await reconcileEpisodeRun(item), false);
  } finally { delete process.env.VERCEL; }
});
