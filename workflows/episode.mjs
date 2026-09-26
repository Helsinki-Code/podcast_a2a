import { defineHook, sleep } from 'workflow';
import { runConversation } from '../lib/conversation-loop.mjs';
import { begin, snapshot, plan, prepareSpeech, publishSpeech, act, finish, emitInterruption, emitNotice, interjectionVerdict, expired, newEventId, summarize } from './episode-steps.mjs';
import { renderPodcastTimeline, failPodcastRender } from './podcast-render-steps.mjs';

export const playbackHook = defineHook();
export const playbackToken = (episodeId, eventId) => `podcast:${episodeId}:${eventId}`;

// Keep hook creation, speech publication, and acknowledgement waiting inside one workflow
// function. Returning closures from a workflow function is not serializable, and calling a
// callback through an object would make Workflow try to serialize that object as `thisVal`.
async function publishSpeechAndWait(episodeId, role, text, eventId, prepared, sources = []) {
  const hook = playbackHook.create({ token: playbackToken(episodeId, eventId) });
  const conflict = await hook.getConflict();
  if (conflict) throw new Error(`Playback hook is already owned by run ${conflict.runId}.`);
  await publishSpeech(episodeId, role, text, eventId, prepared, false, sources);
  const playback = await Promise.race([hook, sleep('5m').then(() => ({ timeout: true }))]);
  hook.dispose();
  return playback;
}

export async function episodeWorkflow(episodeId, launch = {}) {
  'use workflow';
  await runConversation(episodeId, {
    begin, snapshot, plan, prepareSpeech, publishSpeech, act, finish, emitInterruption, emitNotice, interjectionVerdict, expired, newEventId, summarize,
    publishSpeechAndWait, render: renderPodcastTimeline, failRender: failPodcastRender
  });
}
