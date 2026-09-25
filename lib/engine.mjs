import { runConversation } from './conversation-loop.mjs';
import { setEpisodeFields, onEpisodeEvent } from './store.mjs';
import * as steps from '../workflows/episode-steps.mjs';

// Local (non-Vercel) runner. It uses the same turn loop and steps as the durable workflow; only
// playback acknowledgement and live event delivery differ.
const active = new Map();
export function controller(id) { return active.get(id); }

export async function runEpisode(episode, publish, waitForAck) {
  if (active.has(episode.id)) throw new Error('Episode is already running.');
  const state = { stop: false };
  active.set(episode.id, state);
  const unsubscribe = onEpisodeEvent(episode.id, event => publish(episode.id, event));
  try {
    await runConversation(episode.id, {
      ...steps,
      playbackWaiter: async (episodeId, eventId) => {
        // Register before the speech is published so an early acknowledgement is not lost.
        const acknowledged = waitForAck(episodeId, eventId, () => state.stop).then(() => ({ played: true }), () => ({ timeout: true }));
        return { wait: () => acknowledged, dispose() {} };
      }
    });
  } finally {
    unsubscribe();
    active.delete(episode.id);
  }
}

export async function stopEpisode(id) {
  const run = active.get(id);
  if (run) run.stop = true;
  await setEpisodeFields(id, { stopRequested: true });
  return !!run;
}
