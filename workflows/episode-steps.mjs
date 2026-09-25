import { episode, appendEpisodeEvent, setEpisodeFields, stamp, uid, putNamedAsset, refundCredits } from '../lib/store.mjs';
import { modelProviders, speechProviders, supportedVoice } from '../lib/providers.mjs';
import { ownContext } from '../lib/conversation.mjs';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';

async function emit(episodeId, type, payload = {}, turn = null, eventId = uid()) {
  const event = { id: eventId, at: stamp(), type, ...payload };
  await appendEpisodeEvent(episodeId, event, turn);
  return event;
}
export async function begin(episodeId) {
  'use step';
  await setEpisodeFields(episodeId, { status: 'running', startedAt: stamp(), error: null });
  await emit(episodeId, 'status', { status: 'running' });
}
export async function snapshot(episodeId) {
  'use step';
  return episode(episodeId);
}
export async function newEventId() {
  'use step';
  return uid();
}
export async function expired(episodeId) {
  'use step';
  const item = await episode(episodeId);
  return Date.now() >= new Date(item.startedAt).getTime() + item.settings.maxMinutes * 60000;
}
export async function plan(episodeId, role, screen, mode, extra = '') {
  'use step';
  const item = await episode(episodeId);
  const agent = item.personas[role];
  const provider = modelProviders.get(agent.modelProvider || 'gateway');
  if (!provider) throw new Error(`Model provider unavailable: ${agent.modelProvider}`);
  if (mode === 'turn') await emit(episodeId, 'thinking', { role });
  return provider.generate(ownContext(item, role, agent, screen, mode, extra), agent.model);
}
export async function interjectionVerdict(episodeId, otherRole, currentRole, phrase, screen) {
  'use step';
  const item = await episode(episodeId);
  if (Math.random() < (Number(item.settings.interjectProbability) || 0)) return { interrupt: true, reason: 'spontaneous interjection' };
  const agent = item.personas[otherRole];
  const provider = modelProviders.get(agent.modelProvider || 'gateway');
  return provider.generate(ownContext(item, otherRole, agent, screen, 'interrupt', `The ${currentRole} is still speaking and just said: ${phrase}`), agent.model);
}
export async function prepareSpeech(episodeId, role, text) {
  'use step';
  const item = await episode(episodeId);
  const agent = item.personas[role];
  const providerName = agent.speechProvider || 'gateway';
  const provider = speechProviders.get(providerName);
  if (!provider) throw new Error(`Speech provider unavailable: ${agent.speechProvider}`);
  const speech = await provider.synthesize(text, supportedVoice(providerName, agent.voice, role === 'host' ? 'coral' : 'nova'));
  const chunks = [];
  for await (const chunk of Buffer.isBuffer(speech) || speech instanceof Uint8Array ? [speech] : speech) chunks.push(Buffer.from(chunk));
  const audioId = uid();
  await putNamedAsset(`${audioId}.mp3`, Buffer.concat(chunks));
  return { audio: `/api/audio/${audioId}` };
}
export async function publishSpeech(episodeId, role, text, eventId, prepared) {
  'use step';
  const turn = { id: uid(), at: stamp(), role, text };
  return emit(episodeId, 'speech', { role, text, audio: prepared.audio, turnId: turn.id }, turn, eventId);
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
  const item = await episode(episodeId);
  if (status === 'failed' && item?.creditsCharged && item.ownerId) await refundCredits(item.ownerId, item.creditsCharged, 'podcast', episodeId);
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
