import { defineHook, sleep } from 'workflow';
import { demoLeadInComplete, speechBlocks, speechPhrases } from '../lib/conversation.mjs';
import { begin, snapshot, plan, prepareSpeech, publishSpeech, act, finish, emitInterruption, emitNotice, interjectionVerdict, expired, newEventId } from './episode-steps.mjs';
import { renderPodcastTimeline, failPodcastRender } from './podcast-render-steps.mjs';

export const playbackHook = defineHook();
export const playbackToken = (episodeId, eventId) => `podcast:${episodeId}:${eventId}`;

function firstSpeech(response, role) {
  for (const segment of Array.isArray(response?.segments) ? response.segments : []) {
    if (segment.type !== 'speak') continue;
    const phrase = (role === 'guest' ? speechBlocks : speechPhrases)(String(segment.text || '').trim().slice(0, 3500))[0];
    if (phrase) return phrase;
  }
  return '';
}

export async function episodeWorkflow(episodeId, launch = {}) {
  'use workflow';
  try {
    await begin(episodeId);
    let role = 'host';
    let screen = { type: 'idle', title: 'Conversation in progress', content: 'The browser demonstration will begin after the opening discussion.' };
    let actionsThisTurn = 0;
    let prefetched = null;
    let prefetchedRole = null;
    let prefetchedSpeech = null;
    while (!await expired(episodeId)) {
      const item = await snapshot(episodeId);
      if (item.stopRequested) break;
      const response = prefetched && prefetchedRole === role ? prefetched : await plan(episodeId, role, screen, 'turn');
      prefetched = null;
      prefetchedRole = null;
      const segments = Array.isArray(response.segments) ? response.segments.slice(0, 8) : [];
      const guestDemoDone = item.events?.some(event => event.type === 'tool_end' && event.role === 'guest' && event.tool === 'browser');
      if (role === 'guest' && item.settings.requireGuestDemo && demoLeadInComplete(item) && !guestDemoDone && !segments.some(segment => segment.type === 'act' && segment.tool === 'browser')) {
        const fallback = item.settings.demo?.url || `https://www.google.com/search?q=${encodeURIComponent(item.outline.subject)}`;
        segments.push({ type: 'act', tool: 'browser', input: { action: 'visit', url: fallback } });
      }
      if (!segments.length) throw new Error(`${role} returned no speech or action.`);
      let interrupted = false;
      let replan = false;
      for (const segment of segments) {
        if ((await snapshot(episodeId)).stopRequested) break;
        if (segment.type === 'speak') {
          const phrases = (role === 'guest' ? speechBlocks : speechPhrases)(String(segment.text || '').trim().slice(0, 3500));
          let preparedPhrase = prefetchedSpeech?.role === role && prefetchedSpeech.text === phrases[0] ? prefetchedSpeech.prepared : null;
          prefetchedSpeech = null;
          for (let index = 0; index < phrases.length; index++) {
            const phrase = phrases[index];
            if (!phrase) continue;
            const prepared = preparedPhrase || await prepareSpeech(episodeId, role, phrase);
            preparedPhrase = null;
            const eventId = await newEventId();
            const hook = playbackHook.create({ token: playbackToken(episodeId, eventId) });
            const conflict = await hook.getConflict();
            if (conflict) throw new Error(`Playback hook is already owned by run ${conflict.runId}.`);
            await publishSpeech(episodeId, role, phrase, eventId, prepared);
            const isLastPhrase = index === phrases.length - 1 && segment === segments.at(-1);
            const nextRole = role === 'host' ? 'guest' : 'host';
            const nextPlan = isLastPhrase && !(role === 'host' && response.finish === true) ? plan(episodeId, nextRole, screen, 'turn') : null;
            const nextPhrase = phrases[index + 1] || '';
            const preparation = nextPhrase
              ? prepareSpeech(episodeId, role, nextPhrase).then(value => ({ kind: 'phrase', value }))
              : nextPlan
                ? (async () => {
                    const planned = await nextPlan;
                    const text = firstSpeech(planned, nextRole);
                    const nextPrepared = text ? await prepareSpeech(episodeId, nextRole, text) : null;
                    return { kind: 'turn', planned, text, prepared: nextPrepared };
                  })()
                : null;
            const playbackWait = Promise.race([hook, sleep('5m').then(() => ({ timeout: true }))]);
            const [playback, preparedNext] = preparation ? await Promise.all([playbackWait, preparation]) : [await playbackWait, null];
            hook.dispose();
            if (playback?.timeout) throw new Error('Playback client did not acknowledge speech within five minutes.');
            if (preparedNext?.kind === 'phrase') preparedPhrase = preparedNext.value;
            if (preparedNext?.kind === 'turn') {
              prefetched = preparedNext.planned;
              prefetchedRole = nextRole;
              if (preparedNext.prepared) prefetchedSpeech = { role: nextRole, text: preparedNext.text, prepared: preparedNext.prepared };
            }
            const current = await snapshot(episodeId);
            if (current.stopRequested) break;
            if (current.settings.interjections && (index < phrases.length - 1 || segment !== segments.at(-1))) {
              const otherRole = role === 'host' ? 'guest' : 'host';
              const verdict = await interjectionVerdict(episodeId, otherRole, role, phrase, screen);
              if (verdict.interrupt === true) {
                await emitInterruption(episodeId, otherRole, String(verdict.reason || '').slice(0, 200));
                interrupted = true;
                break;
              }
            }
          }
          if (interrupted) break;
        } else if (segment.type === 'act') {
          const current = await snapshot(episodeId);
          if (role === 'host' && !current.settings.hostTools) continue;
          const name = String(segment.tool || '');
          if (!['code', 'browser', 'diagram', 'file', 'play_audio'].includes(name)) continue;
          if (name === 'browser' && current.settings.requireGuestDemo && !demoLeadInComplete(current)) continue;
          screen = await act(episodeId, role, name, segment.input || {}, screen);
          actionsThisTurn++;
          if (actionsThisTurn < 6) replan = true;
          else await emitNotice(episodeId, `${role} reached the per-turn tool safety limit.`);
          break;
        }
      }
      if ((await snapshot(episodeId)).stopRequested) break;
      if (replan && !interrupted) continue;
      if (role === 'host' && response.finish === true && (await snapshot(episodeId)).turns.some(turn => turn.role === 'guest')) break;
      role = role === 'host' ? 'guest' : 'host';
      actionsThisTurn = 0;
    }
    await finish(episodeId, (await snapshot(episodeId)).stopRequested ? 'stopped' : 'complete');
    try { await renderPodcastTimeline(episodeId); }
    catch (renderError) { await failPodcastRender(episodeId, renderError.message || 'Podcast rendering failed.'); }
  } catch (cause) {
    await finish(episodeId, 'failed', cause.message || 'Episode failed.');
  }
}
