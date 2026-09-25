import { parseModelJson } from './model-json.mjs';

export const modelProviders = new Map();
export const speechProviders = new Map();
export const registerModel = (name, provider) => modelProviders.set(name, provider);
export const registerSpeech = (name, provider) => speechProviders.set(name, provider);

// JSON mode still fails when a model wraps its object in fences or prose, or runs out of tokens.
// Salvage the object from the raw text, then ask once for a clean JSON rewrite before giving up.
async function generateJsonObject(request, label) {
  const { generateText, NoObjectGeneratedError } = await import('ai');
  let text = '';
  try {
    const { output } = await generateText(request);
    if (output && typeof output === 'object' && !Array.isArray(output)) return output;
    text = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  } catch (error) {
    if (!NoObjectGeneratedError.isInstance(error)) throw error;
    text = String(error.text || '');
  }
  const salvaged = parseModelJson(text);
  if (salvaged) return salvaged;
  const { output: _output, ...rest } = request;
  const repair = await generateText({
    ...rest,
    instructions: `${request.instructions || ''}\n\nReturn only one complete, valid JSON object. No markdown fences, comments, or text outside the object. Keep string values concise so the object is never truncated.`,
    messages: [...request.messages, ...(text ? [{ role: 'assistant', content: text.slice(0, 12000) }] : []), { role: 'user', content: 'Your previous reply was not a valid JSON object. Reply again with only the complete JSON object that follows the required format.' }]
  });
  const repaired = parseModelJson(repair.text);
  if (repaired) return repaired;
  throw new Error(`AI Gateway returned an invalid ${label}: the model response was not a JSON object.`);
}

registerModel('gateway', {
  ready: () => Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL),
  async generate(messages, model, options = {}) {
    const { Output } = await import('ai');
    const { gateway } = await import('@ai-sdk/gateway');
    const modelId = model || process.env.AI_GATEWAY_MODEL || 'google/gemini-2.5-flash-lite';
    if (!/^[a-z0-9-]+\/[a-z0-9][a-z0-9._-]*$/i.test(modelId)) throw new Error('AI Gateway model must use provider/model format.');
    const instructions = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
    const conversation = messages.filter(message => message.role !== 'system');
    const fallbackModels = String(process.env.AI_GATEWAY_FALLBACK_MODELS || 'google/gemini-3.1-flash-lite').split(',').map(value => value.trim()).filter(value => value && value !== modelId);
    return generateJsonObject({
      model: gateway(modelId),
      instructions,
      messages: conversation,
      output: Output.json(),
      providerOptions: { gateway: { ...(fallbackModels.length ? { models: fallbackModels } : {}), ...(options.user ? { user: options.user } : {}), tags: options.tags || ['feature:podcast'] } },
      timeout: 90000
    }, 'episode plan');
  },
  async generateVisual(messages, image, model, options = {}) {
    const { Output, jsonSchema } = await import('ai');
    const { gateway } = await import('@ai-sdk/gateway');
    const modelId = model || process.env.AI_GATEWAY_COMPUTER_MODEL || process.env.AI_GATEWAY_MODEL || 'google/gemini-2.5-flash-lite';
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
      output: options.output === 'podcast' ? Output.json() : explainerOutput,
      providerOptions: { gateway: { ...(() => { const models = String(process.env.AI_GATEWAY_VISION_FALLBACK_MODELS || 'google/gemini-3.1-flash-lite').split(',').map(value => value.trim()).filter(value => value && value !== modelId); return models.length ? { models } : {}; })(), ...(options.user ? { user: options.user } : {}), tags: options.tags || ['feature:computer-use'] } },
      timeout: 90000
    }, `${options.output === 'podcast' ? 'podcast' : 'computer-use'} plan`);
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
      model: model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages, response_format: { type: 'json_object' }
    });
    const result = await response.json();
    return JSON.parse(result.choices[0].message.content);
  }
});

registerSpeech('openai', {
  ready: () => !!process.env.OPENAI_API_KEY,
  voices: ['alloy','ash','ballad','coral','echo','fable','onyx','nova','sage','shimmer','verse','marin','cedar'],
  async synthesize(text, voice) {
    const response = await apiFetch('audio/speech', {
      model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts', voice: voice || 'alloy', input: text.slice(0, 4000), response_format: 'mp3'
    });
    return response.body;
  }
});

registerSpeech('gateway', {
  ready: () => Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL),
  voices: ['alloy','ash','coral','echo','fable','nova','onyx','sage','shimmer'],
  async synthesize(text, voice) {
    const { generateSpeech } = await import('ai');
    const { gateway } = await import('@ai-sdk/gateway');
    const result = await generateSpeech({
      model: gateway.speechModel(process.env.AI_GATEWAY_TTS_MODEL || 'openai/tts-1'),
      text: text.slice(0, 4000), voice: voice || 'coral', outputFormat: 'mp3'
    });
    return result.audio.uint8Array;
  }
});

export function supportedVoice(providerName, requested, fallback = 'alloy') {
  const voices = speechProviders.get(providerName)?.voices || [];
  if (voices.includes(requested)) return requested;
  if (voices.includes(fallback)) return fallback;
  return voices[0] || fallback;
}

export function availableProviders() { return {
  models: [...modelProviders.keys()], speech: [...speechProviders.keys()],
  voices: Object.fromEntries([...speechProviders].map(([name, provider]) => [name, provider.voices || []])),
  ready: { models: Object.fromEntries([...modelProviders].map(([name, provider]) => [name, provider.ready?.() !== false])), speech: Object.fromEntries([...speechProviders].map(([name, provider]) => [name, provider.ready?.() !== false])) }
}; }
