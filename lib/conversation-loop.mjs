import { demoLeadInComplete, guestDemoDone, interjectionTrigger, speechBlocks, spokenMinutes } from './conversation.mjs';
import { isGuestRole, isHostSide, nextSpeaker, personaName } from './cast.mjs';

// The turn broker shared by the durable Vercel workflow and the local server. Every side effect
// goes through `io`, so this module stays deterministic and can run inside the workflow runtime.
const TOOL_NAMES = ['code', 'browser', 'diagram', 'file', 'play_audio'];
const MAX_TOOL_ACTIONS_PER_TURN = 6;
const MAX_CONSECUTIVE_PLAN_FAILURES = 4;
const MEMORY_WINDOW = 18;
const MEMORY_KEEP_VERBATIM = 8;

// Whole thoughts are voiced in one request so the TTS can phrase them naturally; guests get longer blocks.
export const splitSpeech = (role, text) => speechBlocks(String(text || '').trim().slice(0, 3500), isGuestRole(role) ? 72 : 48).filter(Boolean);

// Interruptions are rare by design: only on a real trigger (or the configured spontaneous chance),
// at most `maxInterruptions` per episode, and never within two turns of the previous one.
export function interruptionAllowed(item, stats) {
  const settings = item?.settings || {};
  if (!settings.interjections) return false;
  const cap = Number.isFinite(Number(settings.maxInterruptions)) ? Number(settings.maxInterruptions) : 4;
  if (stats.count >= cap) return false;
  return stats.lastTurn < 0 || (item.turns?.length || 0) - stats.lastTurn >= 2;
}

function firstSpeech(response, role) {
  for (const segment of Array.isArray(response?.segments) ? response.segments : []) {
    if (segment.type !== 'speak') continue;
    const phrase = splitSpeech(role, segment.text)[0];
    if (phrase) return phrase;
  }
  return '';
}

// Resume after a failure: the persona who did not speak last goes next.
export function nextRoleAfter(turns = [], episode = null) {
  const last = [...turns].reverse().find(turn => isHostSide(turn.role) || isGuestRole(turn.role));
  return last ? nextSpeaker(episode || { turns }, last.role) : 'host';
}

// What the turn loop reads from an episode. The durable workflow stores every step result in its
// event log and replays it on each step, so the snapshot must not carry persona knowledge,
// embeddings, prompts, or the event log.
export function loopView(item) {
  if (!item) return item;
  const personas = Object.fromEntries(Object.entries(item.personas || {}).map(([role, persona]) => [role, { id: persona?.id, name: persona?.name }]));
  return {
    id: item.id, status: item.status, stopRequested: Boolean(item.stopRequested), startedAt: item.startedAt,
    settings: item.settings || {}, outline: { subject: item.outline?.subject || '' }, personas,
    turns: (item.turns || []).map(turn => ({ role: turn.role, text: turn.text })),
    memory: item.memory ? { throughTurn: item.memory.throughTurn } : null,
    lastScreen: item.lastScreen || null, guestDemoDone: Boolean(item.guestDemoDone)
  };
}

export function hasUsableConversation(item) {
  const turns = item?.turns || [];
  return turns.filter(turn => isHostSide(turn.role)).length >= 2 && turns.filter(turn => isGuestRole(turn.role)).length >= 2;
}

export async function conversationLoop(episodeId, io) {
  const initial = await io.snapshot(episodeId);
  const background = initial?.settings?.playbackMode === 'background';
  let role = nextRoleAfter(initial?.turns, initial);
  const interruptions = { count: 0, lastTurn: -1 };
  let screen = initial?.lastScreen || { type: 'idle', title: 'Conversation in progress', content: 'The browser demonstration will begin after the opening discussion.' };
  let actionsThisTurn = 0;
  let prefetched = null;
  let prefetchedRole = null;
  let prefetchedSpeech = null;
  let planFailures = 0;
  let retryHint = '';
  const stopRequested = async () => Boolean((await io.snapshot(episodeId))?.stopRequested);

  while (!await io.expired(episodeId)) {
    const item = await io.snapshot(episodeId);
    if (item.stopRequested) break;
    const target = Number(item.settings?.targetMinutes) || 0;
    if (target && spokenMinutes(item.turns) >= target * 1.6) {
      await io.emitNotice(episodeId, `The episode reached ${Math.round(target * 1.6)} minutes of speech, well past its ${target}-minute target, and was closed.`);
      break;
    }
    if (io.summarize && (item.turns?.length || 0) - (Number(item.memory?.throughTurn) || 0) > MEMORY_WINDOW) {
      await io.summarize(episodeId, item.turns.length - MEMORY_KEEP_VERBATIM).catch(() => null);
    }
    let response;
    try {
      response = prefetched && prefetchedRole === role && !retryHint ? prefetched : await io.plan(episodeId, role, screen, 'turn', retryHint);
      planFailures = 0;
      retryHint = '';
    } catch (cause) {
      planFailures++;
      prefetched = null;
      prefetchedSpeech = null;
      const message = String(cause?.message || cause).slice(0, 300);
      if (planFailures >= MAX_CONSECUTIVE_PLAN_FAILURES) {
        if (hasUsableConversation(item)) {
          await io.emitNotice(episodeId, `The ${role} could not continue (${message}). The episode was wrapped up with the conversation so far.`);
          break;
        }
        throw cause;
      }
      await io.emitNotice(episodeId, `The ${role}'s turn could not be used and was regenerated: ${message}`);
      retryHint = 'Your previous reply could not be used. Reply again with one complete, valid response that follows the required JSON format and speaking rules.';
      // After two failures in a row from the same persona, let the other persona carry the conversation.
      if (planFailures === 2) { role = nextSpeaker(item, role); actionsThisTurn = 0; }
      continue;
    }
    prefetched = null;
    prefetchedRole = null;
    let upcoming = nextSpeaker(item, role, response);
    const sources = Array.isArray(response.sources) ? response.sources.map(String).slice(0, 6) : [];
    const segments = Array.isArray(response.segments) ? response.segments.slice(0, 8) : [];
    if (role === 'guest' && item.settings.requireGuestDemo && demoLeadInComplete(item) && !guestDemoDone(item) && !segments.some(segment => segment.type === 'act' && segment.tool === 'browser')) {
      const fallback = item.settings.demo?.url || `https://www.google.com/search?q=${encodeURIComponent(item.outline.subject)}`;
      segments.push({ type: 'act', tool: 'browser', input: { action: 'visit', url: fallback } });
    }
    if (!segments.length) { retryHint = 'Your previous reply contained no speech. Speak a complete response.'; continue; }
    let interrupted = false;
    let replan = false;
    for (const segment of segments) {
      if (await stopRequested()) break;
      if (segment.type === 'speak') {
        const phrases = splitSpeech(role, segment.text);
        let preparedPhrase = prefetchedSpeech?.role === role && prefetchedSpeech.text === phrases[0] ? prefetchedSpeech.prepared : null;
        prefetchedSpeech = null;
        for (let index = 0; index < phrases.length; index++) {
          const phrase = phrases[index];
          let prepared = preparedPhrase;
          preparedPhrase = null;
          if (!prepared) {
            try { prepared = await io.prepareSpeech(episodeId, role, phrase); }
            catch (cause) {
              await io.emitNotice(episodeId, `A ${role} line was skipped because its voice could not be generated: ${String(cause?.message || cause).slice(0, 200)}`);
              continue;
            }
          }
          const eventId = await io.newEventId();
          const waiter = background ? null : await io.playbackWaiter(episodeId, eventId);
          await io.publishSpeech(episodeId, role, phrase, eventId, prepared, background, sources);
          const isLastPhrase = index === phrases.length - 1 && segment === segments.at(-1);
          const nextRole = upcoming;
          const nextPlan = isLastPhrase && !(role === 'host' && response.finish === true) ? io.plan(episodeId, nextRole, screen, 'turn').catch(() => null) : null;
          const nextPhrase = phrases[index + 1] || '';
          const preparation = nextPhrase
            ? io.prepareSpeech(episodeId, role, nextPhrase).then(value => ({ kind: 'phrase', value }), () => null)
            : nextPlan
              ? (async () => {
                  const planned = await nextPlan;
                  if (!planned) return null;
                  const text = firstSpeech(planned, nextRole);
                  const nextPrepared = text ? await io.prepareSpeech(episodeId, nextRole, text).catch(() => null) : null;
                  return { kind: 'turn', planned, text, prepared: nextPrepared };
                })()
              : null;
          const playbackWait = waiter ? waiter.wait() : Promise.resolve({ played: true });
          const [playback, preparedNext] = preparation ? await Promise.all([playbackWait, preparation]) : [await playbackWait, null];
          waiter?.dispose();
          if (playback?.timeout) throw new Error('The live player stopped responding for five minutes. Switch the episode to background generation to keep producing without an open tab.');
          if (preparedNext?.kind === 'phrase') preparedPhrase = preparedNext.value;
          if (preparedNext?.kind === 'turn') {
            prefetched = preparedNext.planned;
            prefetchedRole = nextRole;
            if (preparedNext.prepared) prefetchedSpeech = { role: nextRole, text: preparedNext.text, prepared: preparedNext.prepared };
          }
          const current = await io.snapshot(episodeId);
          if (current.stopRequested) break;
          if ((index < phrases.length - 1 || segment !== segments.at(-1)) && interruptionAllowed(current, interruptions)) {
            const listener = upcoming;
            const trigger = interjectionTrigger(phrase, personaName(current, listener));
            const verdict = trigger || Number(current.settings.interjectProbability) > 0 ? await io.interjectionVerdict(episodeId, listener, role, phrase, screen, trigger).catch(() => null) : null;
            if (verdict?.interrupt === true) {
              await io.emitInterruption(episodeId, listener, String(verdict.reason || '').slice(0, 200));
              interruptions.count++;
              interruptions.lastTurn = current.turns?.length || 0;
              interrupted = true;
              upcoming = listener;
              prefetched = null;
              prefetchedSpeech = null;
              break;
            }
          }
        }
        if (interrupted) break;
      } else if (segment.type === 'act') {
        const current = await io.snapshot(episodeId);
        if (role === 'host' && !current.settings.hostTools) continue;
        const name = String(segment.tool || '');
        if (!TOOL_NAMES.includes(name)) continue;
        if (name === 'browser' && current.settings.requireGuestDemo && !demoLeadInComplete(current)) continue;
        screen = await io.act(episodeId, role, name, segment.input || {}, screen);
        actionsThisTurn++;
        if (actionsThisTurn < MAX_TOOL_ACTIONS_PER_TURN) replan = true;
        else await io.emitNotice(episodeId, `${role} reached the per-turn tool safety limit.`);
        break;
      }
    }
    if (await stopRequested()) break;
    if (replan && !interrupted) continue;
    if (role === 'host' && response.finish === true && (await io.snapshot(episodeId)).turns.some(turn => isGuestRole(turn.role))) break;
    role = upcoming;
    actionsThisTurn = 0;
  }
}

// Runs a whole episode: the loop, the final status, and (when provided) the MP4 render.
export async function runConversation(episodeId, io) {
  try {
    await io.begin(episodeId);
    await conversationLoop(episodeId, io);
    await io.finish(episodeId, (await io.snapshot(episodeId)).stopRequested ? 'stopped' : 'complete');
  } catch (cause) {
    await io.finish(episodeId, 'failed', cause?.message || 'Episode failed.');
    return;
  }
  if (!io.render) return;
  try { await io.render(episodeId); }
  catch (renderError) { await io.failRender(episodeId, renderError?.message || 'Podcast rendering failed.'); }
}
