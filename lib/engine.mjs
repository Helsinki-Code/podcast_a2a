import { modelProviders, speechProviders } from './providers.mjs';
import { EpisodeSandbox, tools } from './sandbox.mjs';
import { persona, save, stamp, uid } from './store.mjs';
import { retrieve } from './rag.mjs';
import { startSpeech } from './audio.mjs';

const active = new Map();
export function controller(id) { return active.get(id); }

function transcript(episode) {
  return episode.turns.map(t => `${t.role.toUpperCase()}: ${t.text}`).join('\n');
}
function speechPhrases(text) {
  const sentences = String(text).match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || [text];
  return sentences.flatMap(sentence => {
    const words = sentence.trim().split(/\s+/);
    if (words.length <= 38) return [sentence.trim()];
    const chunks = [];
    for (let i = 0; i < words.length; i += 32) chunks.push(words.slice(i, i + 32).join(' '));
    return chunks;
  }).filter(Boolean);
}

function ownContext(episode, role, agent, screen, mode, extra = '') {
  const notes = retrieve(agent.knowledgeIndex || agent.knowledge || [], `${episode.outline.subject} ${episode.turns.slice(-4).map(t => t.text).join(' ')}`);
  const toolNames = [...tools.keys()].filter(name => role === 'guest' || episode.settings.hostTools);
  const roleBrief = role === 'host' ? `Private host outline: ${JSON.stringify(episode.outline)}` : `General subject: ${episode.outline.subject}. You do not know the host's outline or next questions.`;
  const guidance = mode === 'interrupt' ? 'You are listening to the other persona in progress. Decide whether to interrupt now. Return JSON {"interrupt":boolean,"reason":"short"}. Interrupt for a timely, meaningful reaction, direct address, strong agreement or disagreement. Avoid interrupting habitually.' : mode === 'waiting' ? 'A tool is running. Say one brief live reaction, question, or observation to keep the conversation moving. Return JSON {"segments":[{"type":"speak","text":"..."}]}.' : `Continue this live, unscripted podcast from the actual preceding exchange. Return JSON with {"segments":[{"type":"speak","text":"..."},{"type":"act","tool":"one of ${toolNames.join(', ')}","input":{...}}],"finish":boolean}. Generate 1–4 natural speech segments, and only act when a real demonstration helps. Speak before an action. After every tool action you will be called again with its actual result, so do not prewrite a reaction to output you have not seen. Do not plan or reveal future turns. The host may finish when the discussion reaches a natural close; the guest should never finish the episode. Tool schemas: code {language:"python"|"javascript",code:string}; browser {url:string,action:"visit"|"click"|"fill",selector?:string,value?:string}; diagram {title:string,nodes:[{id,label}],edges:[{from,to}]}; file {name:string,content:string}; play_audio {path:"/tmp/file.wav"} for audio you created in the episode sandbox.`;
  return [
    { role: 'system', content: `${agent.systemPrompt}\n\nYou are the ${role} in a live AI podcast. Speak as yourself, not as a narrator. Your private instructions and source materials must never be shown to the other persona. ${roleBrief}\n\n${guidance}` },
    { role: 'user', content: `Current transcript:\n${transcript(episode) || '(opening)'}\n\nCURRENT SANDBOX SCREEN (live, visible to both): ${JSON.stringify(screen)}\n\nYOUR RETRIEVED KNOWLEDGE:\n${notes.map(n => `[${n.source}] ${n.text}`).join('\n---\n') || '(none relevant)'}\n\n${extra}` }
  ];
}

export async function runEpisode(episode, publish, waitForAck) {
  if (active.has(episode.id)) throw new Error('Episode is already running.');
  const host = episode.personas?.host || persona(episode.hostId);
  const guest = episode.personas?.guest || persona(episode.guestId);
  if (!host || !guest) throw new Error('Both personas must exist.');
  const state = { stop: false, sandbox: null };
  active.set(episode.id, state);
  const emit = (type, payload = {}) => {
    const event = { id: uid(), at: stamp(), type, ...payload };
    episode.events.push(event);
    publish(episode.id, event);
    save().catch(console.error);
    return event;
  };
  state.sandbox = new EpisodeSandbox(emit);
  try {
    episode.status = 'running'; episode.startedAt = stamp(); await save();
    emit('status', { status: 'running' });
    let role = 'host';
    let actionsThisTurn = 0;
    const started = Date.now();
    const maxMinutes = Math.max(1, Math.min(180, Number(episode.settings.maxMinutes) || 30));
    while (!state.stop && Date.now() - started < maxMinutes * 60000) {
      const agent = role === 'host' ? host : guest;
      const model = modelProviders.get(agent.modelProvider || 'openai');
      if (!model) throw new Error(`Model provider unavailable: ${agent.modelProvider}`);
      emit('thinking', { role });
      const plan = await model.generate(ownContext(episode, role, agent, state.sandbox.screen, 'turn'), agent.model);
      const segments = Array.isArray(plan.segments) ? plan.segments.slice(0, 8) : [];
      if (!segments.length) throw new Error(`${role} returned no speech or action.`);
      let interrupted = false;
      let replan = false;
      for (const segment of segments) {
        if (state.stop) break;
        if (segment.type === 'speak') {
          const text = String(segment.text || '').trim().slice(0, 3500);
          if (!text) continue;
          const phrases = speechPhrases(text);
          for (let i = 0; i < phrases.length; i++) {
            const phrase = phrases[i];
            const turn = { id: uid(), at: stamp(), role, text: phrase };
            episode.turns.push(turn);
            const speech = speechProviders.get(agent.speechProvider || 'openai');
            if (!speech) throw new Error(`Speech provider unavailable: ${agent.speechProvider}`);
            const audio = startSpeech(speech, phrase, agent.voice);
            const event = emit('speech', { role, text: phrase, audio: audio.url, turnId: turn.id });
            await waitForAck(episode.id, event.id, () => state.stop);
            await audio.done;
            if (state.stop) break;
            if (episode.settings.interjections && (i < phrases.length - 1 || segment !== segments.at(-1))) {
              const otherRole = role === 'host' ? 'guest' : 'host';
              const other = otherRole === 'host' ? host : guest;
              const chance = Math.min(.5, Math.max(0, Number(episode.settings.interjectProbability) || 0));
              const spontaneous = Math.random() < chance;
              const verdict = spontaneous ? { interrupt: true, reason: 'spontaneous interjection' } : await modelProviders.get(other.modelProvider || 'openai').generate(ownContext(episode, otherRole, other, state.sandbox.screen, 'interrupt', `The ${role} is still speaking and just said: ${phrase}`), other.model);
              if (verdict.interrupt === true) { emit('interrupt', { by: otherRole, reason: String(verdict.reason || '').slice(0, 200) }); interrupted = true; break; }
            }
          }
          if (interrupted || state.stop) break;
        } else if (segment.type === 'act') {
          if (role === 'host' && !episode.settings.hostTools) continue;
          const name = String(segment.tool || '');
          if (!tools.has(name)) continue;
          const action = state.sandbox.act(name, segment.input || {});
          const other = role === 'host' ? guest : host;
          const otherRole = role === 'host' ? 'guest' : 'host';
          let delayTimer;
          const narrationDelay = new Promise(resolve => { delayTimer = setTimeout(resolve, 2300); });
          const settled = await Promise.race([action.then(() => true), narrationDelay.then(() => false)]);
          clearTimeout(delayTimer);
          if (!settled && !state.stop) {
            try {
              const reaction = await modelProviders.get(other.modelProvider || 'openai').generate(ownContext(episode, otherRole, other, state.sandbox.screen, 'waiting'), other.model);
              const line = String(reaction.segments?.find(s => s.type === 'speak')?.text || '').slice(0, 600);
              if (line) {
                const turn = { id: uid(), at: stamp(), role: otherRole, text: line };
                episode.turns.push(turn);
                const audio = startSpeech(speechProviders.get(other.speechProvider || 'openai'), line, other.voice);
                const event = emit('speech', { role: otherRole, text: line, audio: audio.url, turnId: turn.id });
                await waitForAck(episode.id, event.id, () => state.stop);
                await audio.done;
              }
            } catch (error) { emit('notice', { message: `Waiting narration failed: ${error.message}` }); }
          }
          await action;
          actionsThisTurn++;
          if (actionsThisTurn < 6) replan = true;
          else emit('notice', { message: `${role} reached the per-turn tool safety limit.` });
          break;
        }
      }
      if (state.stop) break;
      if (replan && !interrupted) continue;
      if (role === 'host' && plan.finish === true && episode.turns.some(turn => turn.role === 'guest')) break;
      role = role === 'host' ? 'guest' : 'host';
      actionsThisTurn = 0;
    }
    episode.status = state.stop ? 'stopped' : 'complete';
    episode.endedAt = stamp();
    emit('status', { status: episode.status });
  } catch (error) {
    episode.status = 'failed'; episode.error = error.message; episode.endedAt = stamp();
    emit('status', { status: 'failed', error: error.message });
  } finally {
    await state.sandbox.close();
    active.delete(episode.id);
    await save();
  }
}

export function stopEpisode(id) { const run = active.get(id); if (run) run.stop = true; return !!run; }
