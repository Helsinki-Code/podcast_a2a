import { parseModelJson } from './model-json.mjs';
import { fallbackModels as fallbacksFor, modelFor } from './models.mjs';
import { recordUsage } from './usage.mjs';

export const modelProviders = new Map();
export const speechProviders = new Map();
export const registerModel = (name, provider) => modelProviders.set(name, provider);
export const registerSpeech = (name, provider) => speechProviders.set(name, provider);

export const EPISODE_PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array', minItems: 1, maxItems: 8,
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['speak', 'act'] },
          text: { type: 'string' },
          tool: { type: 'string', enum: ['code', 'browser', 'diagram', 'file', 'play_audio'] },
          input: { type: 'object', additionalProperties: true }
        },
        required: ['type'], additionalProperties: false
      }
    },
    finish: { type: 'boolean' },
    next: { type: 'string', enum: ['host', 'cohost', 'guest', 'guest2', 'guest3'] },
    sources: { type: 'array', items: { type: 'string' }, maxItems: 6 }
  },
  required: ['segments', 'finish'], additionalProperties: false
};

export const isModelObjectFailure = error => /no object generated|could not parse|invalid .*plan|not a json object|invalid json/i.test(String(error?.message || error));

// JSON mode still fails when a model wraps its object in fences or prose, or runs out of tokens.
// Salvage the object from the raw text, then ask once for a clean JSON rewrite before giving up.
async function generateJsonObject(request, label) {
  const { generateText, NoObjectGeneratedError } = await import('ai');
  let text = '';
  const feature = request.providerOptions?.gateway?.tags?.find(tag => tag.startsWith('feature:'))?.slice(8) || '';
  const track = (result, model = request.model?.modelId) => recordUsage({ feature, model, inputTokens: result?.usage?.inputTokens, outputTokens: result?.usage?.outputTokens });
  try {
    const result = await generateText(request);
    track(result);
    const { output } = result;
    if (output && typeof output === 'object' && !Array.isArray(output)) return output;
    text = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  } catch (error) {
    if (!NoObjectGeneratedError.isInstance(error) && !isModelObjectFailure(error)) throw error;
    text = String(error.text || error.response?.body || '');
  }
  const salvaged = parseModelJson(text);
  if (salvaged) return salvaged;
  const { output: _output, ...rest } = request;
  const repair = await generateText({
    ...rest,
    instructions: `${request.instructions || ''}\n\nReturn only one complete, valid JSON object. No markdown fences, comments, or text outside the object. Keep string values concise so the object is never truncated.`,
    messages: [...request.messages, ...(text ? [{ role: 'assistant', content: text.slice(0, 12000) }] : []), { role: 'user', content: 'Your previous reply was not a valid JSON object. Reply again with only the complete JSON object that follows the required format.' }]
  });
  track(repair);
  const repaired = parseModelJson(repair.text);
  if (repaired) return repaired;
  throw new Error(`AI Gateway returned an invalid ${label}: the model response was not a JSON object.`);
}

registerModel('gateway', {
  ready: () => Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL),
  async generate(messages, model, options = {}) {
    const { Output, jsonSchema } = await import('ai');
    const { gateway } = await import('@ai-sdk/gateway');
    const modelId = model || modelFor('conversation');
    if (!/^[a-z0-9-]+\/[a-z0-9][a-z0-9._-]*$/i.test(modelId)) throw new Error('AI Gateway model must use provider/model format.');
    const instructions = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
    const conversation = messages.filter(message => message.role !== 'system');
    const fallbackModels = fallbacksFor('text', modelId);
    return generateJsonObject({
      model: gateway(modelId),
      instructions,
      messages: conversation,
      output: options.tags?.includes('mode:turn') ? Output.object({ schema: jsonSchema(EPISODE_PLAN_JSON_SCHEMA) }) : Output.json(),
      providerOptions: { gateway: { ...(fallbackModels.length ? { models: fallbackModels } : {}), ...(options.user ? { user: options.user } : {}), tags: options.tags || ['feature:podcast'] } },
      timeout: 90000
    }, 'episode plan');
  },
  async generatePlain(messages, model, options = {}) {
    const { generateText } = await import('ai');
    const { gateway } = await import('@ai-sdk/gateway');
    const modelId = model || modelFor('conversation');
    const instructions = `${messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n')}\n\nRecovery mode: ignore every JSON formatting instruction above. Return only the exact words this persona should say aloud. No JSON, markdown, labels, tool calls, or commentary. ${options.role && /^guest/.test(options.role) ? 'Give a direct, concrete 45–110 word answer to the latest host question.' : 'Give a natural 15–45 word host response with one focused follow-up question.'}`;
    const result = await generateText({
      model: gateway(modelId), instructions,
      messages: messages.filter(message => message.role !== 'system'),
      providerOptions: { gateway: { ...(options.user ? { user: options.user } : {}), tags: [...(options.tags || []), 'recovery:plain-speech'] } },
      timeout: 90000
    });
    recordUsage({ feature: `podcast-${options.role || 'speaker'}-recovery`, model: modelId, inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens });
    return String(result.text || '').replace(/^```(?:text)?\s*|\s*```$/gi, '').trim();
  },
  async generateVisual(messages, image, model, options = {}) {
    const { Output, jsonSchema } = await import('ai');
    const { gateway } = await import('@ai-sdk/gateway');
    const modelId = model || modelFor('computer');
    if (!/^[a-z0-9-]+\/[a-z0-9][a-z0-9._-]*$/i.test(modelId)) throw new Error('AI Gateway computer model must use provider/model format.');
    const instructions = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
    const text = messages.filter(message => message.role !== 'system').map(message => message.content).join('\n\n');
    const explainerOutput = Output.object({ schema: jsonSchema({
      type: 'object',
      properties: {
        narration: { type: 'string' },
        done: { type: 'boolean' },
        action: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['click','double_click','right_click','type','key','scroll','drag','visit','wait'] },
            selector: { type: 'string' },
            x: { type: 'number' }, y: { type: 'number' }, endX: { type: 'number' }, endY: { type: 'number' },
            text: { type: 'string' }, key: { type: 'string' }, direction: { type: 'string', enum: ['up','down'] },
            amount: { type: 'number' }, url: { type: 'string' }, ms: { type: 'number' }
          },
          required: ['type'],
          additionalProperties: false
        }
      },
      required: ['narration','action','done'],
      additionalProperties: false
    }) });
    return generateJsonObject({
      model: gateway(modelId),
      instructions,
      messages: [{ role: 'user', content: [{ type: 'text', text }, { type: 'file', data: image, mediaType: 'image/png' }] }],
      output: options.output === 'podcast' ? Output.object({ schema: jsonSchema(EPISODE_PLAN_JSON_SCHEMA) }) : options.output ? Output.json() : explainerOutput,
      providerOptions: { gateway: { ...(() => { const models = fallbacksFor('vision', modelId); return models.length ? { models } : {}; })(), ...(options.user ? { user: options.user } : {}), tags: options.tags || ['feature:computer-use'] } },
      timeout: 90000
    }, `${options.output === 'podcast' ? 'podcast' : options.output ? 'visual' : 'computer-use'} plan`);
  }
});

async function apiFetch(path, body) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required to run an episode.');
  const response = await fetch(`https://api.openai.com/v1/${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(90000)
  });
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response;
}

registerModel('openai', {
  ready: () => !!process.env.OPENAI_API_KEY,
  async generate(messages, model) {
    const response = await apiFetch('chat/completions', {
      model: model || modelFor('openaiText'),
      messages, response_format: { type: 'json_object' }
    });
    const result = await response.json();
    return JSON.parse(result.choices[0].message.content);
  }
});

// Speech providers take (text, voice, options). options.style is a delivery direction (e.g. "warm,
// curious interviewer"); options.previousText/nextText give neighbouring lines for natural prosody.
const deliveryInstructions = options => [
  'Speak as a natural podcast conversation, not a reading. Use relaxed pacing, brief pauses at commas and between sentences, and light emphasis on the key word of each sentence.',
  options?.style ? `Delivery: ${String(options.style).slice(0, 300)}.` : ''
].filter(Boolean).join(' ');

registerSpeech('openai', {
  ready: () => !!process.env.OPENAI_API_KEY,
  voices: ['alloy','ash','ballad','coral','echo','fable','onyx','nova','sage','shimmer','verse','marin','cedar'],
  async synthesize(text, voice, options = {}) {
    const model = modelFor('openaiSpeech');
    recordUsage({ feature: 'speech', model, characters: text.length });
    const response = await apiFetch('audio/speech', {
      model, voice: voice || 'alloy', input: text.slice(0, 4000), response_format: 'mp3',
      ...(/gpt-4o/.test(model) ? { instructions: deliveryInstructions(options) } : {})
    });
    return response.body;
  }
});

registerSpeech('gateway', {
  ready: () => Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL),
  voices: ['alloy','ash','coral','echo','fable','nova','onyx','sage','shimmer'],
  async synthesize(text, voice, options = {}) {
    const { generateSpeech } = await import('ai');
    const { gateway } = await import('@ai-sdk/gateway');
    const model = modelFor('speech');
    recordUsage({ feature: 'speech', model, characters: text.length });
    const result = await generateSpeech({
      model: gateway.speechModel(model),
      text: text.slice(0, 4000), voice: voice || 'coral', outputFormat: 'mp3',
      ...(/gpt-4o/.test(model) ? { instructions: deliveryInstructions(options) } : {})
    });
    return result.audio.uint8Array;
  }
});

// ElevenLabs: any voice ID from the user's voice library is accepted; previous/next text keeps the
// intonation continuous across the separately generated lines of one answer.
const ELEVENLABS_VOICES = ['21m00Tcm4TlvDq8ikWAM', 'pNInz6obpgDQGcFmaJgB', 'EXAVITQu4vr4xnSDxMaL', 'ErXwobaYiN019PkySvjV', 'TxGEqnHWrfWFTfGW9XjX', 'MF3mGyEYCl7XYWbV9V6O'];
registerSpeech('elevenlabs', {
  ready: () => Boolean(process.env.ELEVENLABS_API_KEY),
  voices: ELEVENLABS_VOICES,
  acceptsVoice: voice => /^[A-Za-z0-9]{16,32}$/.test(String(voice || '')),
  async synthesize(text, voice, options = {}) {
    if (!process.env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is required for ElevenLabs voices.');
    const voiceId = /^[A-Za-z0-9]{16,32}$/.test(String(voice || '')) ? voice : ELEVENLABS_VOICES[0];
    recordUsage({ feature: 'speech', model: modelFor('elevenlabs'), characters: text.length });
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: text.slice(0, 4000),
        model_id: modelFor('elevenlabs'),
        ...(options.previousText ? { previous_text: String(options.previousText).slice(-1000) } : {}),
        ...(options.nextText ? { next_text: String(options.nextText).slice(0, 1000) } : {}),
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true }
      }),
      signal: AbortSignal.timeout(90000)
    });
    if (!response.ok) throw new Error(`ElevenLabs ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return Buffer.from(await response.arrayBuffer());
  }
});

export function supportedVoice(providerName, requested, fallback = 'alloy') {
  const provider = speechProviders.get(providerName);
  const voices = provider?.voices || [];
  if (voices.includes(requested) || provider?.acceptsVoice?.(requested)) return requested;
  if (voices.includes(fallback)) return fallback;
  return voices[0] || fallback;
}

export function availableProviders() { return {
  models: [...modelProviders.keys()], speech: [...speechProviders.keys()],
  voices: Object.fromEntries([...speechProviders].map(([name, provider]) => [name, provider.voices || []])),
  ready: { models: Object.fromEntries([...modelProviders].map(([name, provider]) => [name, provider.ready?.() !== false])), speech: Object.fromEntries([...speechProviders].map(([name, provider]) => [name, provider.ready?.() !== false])) }
}; }
