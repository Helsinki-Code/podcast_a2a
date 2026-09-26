import { episodeState, appendEpisodeEvent, setEpisodeFields, stamp, uid, putNamedAsset, refundCredits } from '../lib/store.mjs';
import { modelProviders, speechProviders, supportedVoice } from '../lib/providers.mjs';
import { ownContext, transcriptForPrompt } from '../lib/conversation.mjs';
import { retrieveHybrid } from '../lib/rag.mjs';
import { DEFAULT_VOICES, isGuestRole } from '../lib/cast.mjs';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';
import { episodePlanHasContent, episodePlanQualityIssue } from '../lib/episode-plan.mjs';

async function emit(episodeId, type, payload = {}, turn = null, eventId = uid()) {
  const event = { id: eventId, at: stamp(), type, ...payload };
  return appendEpisodeEvent(episodeId, event, turn);
}
export async function begin(episodeId) {
  'use step';
  await setEpisodeFields(episodeId, { status: 'running', startedAt: stamp(), error: null });
  await emit(episodeId, 'status', { status: 'running' });
}
export async function snapshot(episodeId) {
  'use step';
  return episodeState(episodeId);
}
export async function newEventId() {
  'use step';
  return uid();
}
export async function expired(episodeId) {
  'use step';
  const item = await episodeState(episodeId);
  return Date.now() >= new Date(item.startedAt).getTime() + item.settings.maxMinutes * 60000;
}
export async function plan(episodeId, role, screen, mode, extra = '') {
  'use step';
  const item = await episodeState(episodeId);
  const agent = item.personas[role];
  const providerName = agent.modelProvider || 'gateway';
  const provider = modelProviders.get(providerName);
  if (!provider) throw new Error(`Model provider unavailable: ${agent.modelProvider}`);
  if (mode === 'turn') await emit(episodeId, 'thinking', { role });
  const query = `${item.outline.subject} ${item.turns.slice(-4).map(turn => turn.text).join(' ')}`;
  const notes = await retrieveHybrid(agent.knowledgeIndex || [], query).catch(() => undefined);
  const messages = ownContext(item, role, agent, screen, mode, extra, { notes });
  const selectedModel = agent.model || (providerName === 'gateway' ? (isGuestRole(role) ? process.env.AI_GATEWAY_GUEST_MODEL : process.env.AI_GATEWAY_HOST_MODEL) || process.env.AI_GATEWAY_MODEL : undefined);
  const routing = { user: item.ownerId, tags: [`feature:podcast-${role}`, `mode:${mode}`] };
  let result;
  if (process.env.COMPUTER_USE_SNAPSHOT_ID && mode === 'turn' && screen?.type === 'browser' && provider.generateVisual) {
    const capture = await new VercelEpisodeSandbox(episodeId, () => {}, screen, role).captureForModel(item.settings?.demo?.url || '');
    const visualModel = process.env.AI_GATEWAY_GUEST_COMPUTER_MODEL || process.env.AI_GATEWAY_COMPUTER_MODEL || selectedModel;
    result = await provider.generateVisual(messages, capture.image, visualModel, { ...routing, output: 'podcast' });
  } else result = await provider.generate(messages, selectedModel, routing);
  if (!episodePlanHasContent(result, mode)) throw new Error(`${role} model returned no ${mode === 'interrupt' ? 'interruption verdict' : 'speech or action'}.`);
  const qualityIssue = episodePlanQualityIssue(result, { role, mode });
  if (qualityIssue) throw new Error(`${role} ${qualityIssue}. Regenerate a complete, direct response to the preceding exchange.`);
  // Only keep citations for knowledge the persona actually has.
  const known = new Set((agent.knowledge || []).map(file => file.name));
  if (Array.isArray(result.sources)) result.sources = result.sources.map(String).filter(source => known.has(source)).slice(0, 6);
  return result;
}
// The model is consulted only when a cheap trigger fired; otherwise only the spontaneous chance applies.
export async function interjectionVerdict(episodeId, otherRole, currentRole, phrase, screen, trigger = '') {
  'use step';
  const item = await episodeState(episodeId);
  if (Math.random() < (Number(item.settings.interjectProbability) || 0)) return { interrupt: true, reason: 'spontaneous interjection' };
  if (!trigger) return { interrupt: false };
  const agent = item.personas[otherRole];
  const providerName = agent.modelProvider || 'gateway';
  const provider = modelProviders.get(providerName);
  const routerModel = agent.model || (providerName === 'gateway' ? process.env.AI_GATEWAY_ROUTER_MODEL || 'google/gemini-2.5-flash-lite' : undefined);
  return provider.generate(ownContext(item, otherRole, agent, screen, 'interrupt', `The ${currentRole} is still speaking and just said (${trigger}): ${phrase}`), routerModel, { user: item.ownerId, tags: ['feature:podcast-interjection'] });
}
// Condenses everything before `throughTurn` into a running summary for long episodes.
export async function summarize(episodeId, throughTurn) {
  'use step';
  const item = await episodeState(episodeId);
  const upTo = Math.max(0, Math.min(item.turns.length, Number(throughTurn) || 0));
  if (upTo <= (Number(item.memory?.throughTurn) || 0)) return item.memory || null;
  const provider = modelProviders.get('gateway');
  if (!provider?.ready?.()) return item.memory || null;
  const earlier = transcriptForPrompt({ ...item, turns: item.turns.slice(0, upTo) });
  const result = await provider.generate([
    { role: 'system', content: 'You keep running notes for a live podcast. Return JSON {"summary":string}. Summarize the conversation so far in at most 180 words: the main questions asked, each speaker\'s key claims and examples, any demo shown, and open threads. Name speakers. No commentary.' },
    { role: 'user', content: earlier }
  ], process.env.AI_GATEWAY_ROUTER_MODEL || process.env.AI_GATEWAY_MODEL, { user: item.ownerId, tags: ['feature:podcast-memory'] });
  const summary = String(result?.summary || '').trim().slice(0, 2500);
  if (!summary) return item.memory || null;
  const memory = { summary, throughTurn: upTo, updatedAt: stamp() };
  await setEpisodeFields(episodeId, { memory });
  return memory;
}
export async function prepareSpeech(episodeId, role, text) {
  'use step';
  const item = await episodeState(episodeId);
  const agent = item.personas[role];
  const providerName = agent.speechProvider || 'gateway';
  const provider = speechProviders.get(providerName);
  if (!provider) throw new Error(`Speech provider unavailable: ${agent.speechProvider}`);
  const previousText = [...(item.turns || [])].reverse().find(turn => turn.role === role)?.text || '';
  const speech = await provider.synthesize(text, supportedVoice(providerName, agent.voice, DEFAULT_VOICES[role] || 'nova'), { style: agent.voiceStyle, previousText });
  const chunks = [];
  for await (const chunk of Buffer.isBuffer(speech) || speech instanceof Uint8Array ? [speech] : speech) chunks.push(Buffer.from(chunk));
  const audioId = uid();
  await putNamedAsset(`${audioId}.mp3`, Buffer.concat(chunks));
  return { audio: `/api/audio/${audioId}` };
}
// In background mode nobody plays the clip live, so the speech is published already acknowledged.
export async function publishSpeech(episodeId, role, text, eventId, prepared, acknowledged = false, sources = []) {
  'use step';
  const turn = { id: uid(), at: stamp(), role, text, ...(sources?.length ? { sources } : {}) };
  return emit(episodeId, 'speech', { role, text, audio: prepared.audio, turnId: turn.id, ...(sources?.length ? { sources } : {}), ...(acknowledged ? { acknowledged: true, background: true } : {}) }, turn, eventId);
}
export async function prepareDemo(episodeId, demo, prepared = false) {
  'use step';
  if (!demo?.url) return { type: 'idle', title: 'Sandbox ready', content: '' };
  const sandbox = new VercelEpisodeSandbox(episodeId, (type, payload) => emit(episodeId, type, payload), undefined, 'system');
  if (!demo.authRequired) return sandbox.act('browser', { action: 'visit', url: demo.url });
  if (!prepared) throw new Error('The authenticated browser was not prepared before recording.');
  await emit(episodeId, 'tool_start', { role: 'system', tool: 'browser', input: { action: 'resume', url: demo.url } });
  try {
    const screen = await sandbox.capture();
    await emit(episodeId, 'tool_end', { role: 'system', tool: 'browser', screen });
    return screen;
  } catch (cause) {
    const screen = { type: 'error', title: 'Platform login failed', content: cause.message };
    await emit(episodeId, 'tool_end', { role: 'system', tool: 'browser', screen });
    throw cause;
  }
}
export async function act(episodeId, role, name, input, screen) {
  'use step';
  const sandbox = new VercelEpisodeSandbox(episodeId, (type, payload) => emit(episodeId, type, payload), screen, role);
  return sandbox.act(name, input);
}
export async function finish(episodeId, status, error = null) {
  'use step';
  const item = await episodeState(episodeId);
  if (status === 'failed' && item?.creditsCharged && item.ownerId) await refundCredits(item.ownerId, item.creditsCharged, 'podcast', item.creditReference || episodeId);
  const fields = { status, endedAt: stamp() };
  if (error) fields.error = error;
  await setEpisodeFields(episodeId, fields);
  await emit(episodeId, 'status', { status, ...(error ? { error } : {}) });
  try { await new VercelEpisodeSandbox(episodeId, () => {}).close(); } catch {}
}
export async function emitInterruption(episodeId, by, reason) {
  'use step';
  await emit(episodeId, 'interrupt', { by, reason });
}
export async function emitNotice(episodeId, message) {
  'use step';
  await emit(episodeId, 'notice', { message });
}
