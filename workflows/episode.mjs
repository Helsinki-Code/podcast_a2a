import { defineHook, sleep } from 'workflow';
import { runConversation } from '../lib/conversation-loop.mjs';
import { begin, snapshot, plan, prepareSpeech, publishSpeech, act, finish, emitInterruption, emitNotice, interjectionVerdict, expired, newEventId } from './episode-steps.mjs';
import { renderPodcastTimeline, failPodcastRender } from './podcast-render-steps.mjs';

export const playbackHook = defineHook();
export const playbackToken = (episodeId, eventId) => `podcast:${episodeId}:${eventId}`;

// The hook is created before the speech is published so an acknowledgement can never arrive first.
async function playbackWaiter(episodeId, eventId) {
  const hook = playbackHook.create({ token: playbackToken(episodeId, eventId) });
  const conflict = await hook.getConflict();
  if (conflict) throw new Error(`Playback hook is already owned by run ${conflict.runId}.`);
  return {
    wait: () => Promise.race([hook, sleep('5m').then(() => ({ timeout: true }))]),
    dispose: () => hook.dispose()
  };
}

export async function episodeWorkflow(episodeId, launch = {}) {
  'use workflow';
  await runConversation(episodeId, {
    begin, snapshot, plan, prepareSpeech, publishSpeech, act, finish, emitInterruption, emitNotice, interjectionVerdict, expired, newEventId,
    playbackWaiter, render: renderPodcastTimeline, failRender: failPodcastRender
  });
}
