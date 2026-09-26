// Every model choice in one place. Each purpose reads its own env override, then the shared
// default, so a deployment can retune one step without touching code.
const DEFAULT_TEXT = 'google/gemini-2.5-flash-lite';
const DEFAULT_VISION = 'google/gemini-3.1-flash-lite';

const PURPOSES = {
  conversation: { env: 'AI_GATEWAY_MODEL', fallback: DEFAULT_TEXT, description: 'Default for text generation' },
  host: { env: 'AI_GATEWAY_HOST_MODEL', inherit: 'conversation', description: 'Podcast host and co-host turns' },
  guest: { env: 'AI_GATEWAY_GUEST_MODEL', inherit: 'conversation', description: 'Podcast guest turns' },
  guestComputer: { env: 'AI_GATEWAY_GUEST_COMPUTER_MODEL', inherit: 'computer', description: 'Guest turns that look at a screenshot' },
  router: { env: 'AI_GATEWAY_ROUTER_MODEL', fallback: DEFAULT_TEXT, description: 'Interruption decisions and running summaries' },
  metadata: { env: 'AI_GATEWAY_METADATA_MODEL', inherit: 'conversation', description: 'Titles, descriptions, chapters, shorts, translation' },
  explainer: { env: 'EXPLAINER_MODEL', fallback: DEFAULT_VISION, description: 'Explainer planning and directing' },
  computer: { env: 'AI_GATEWAY_COMPUTER_MODEL', inherit: 'conversation', description: 'Screenshot-based decisions' },
  embedding: { env: 'AI_GATEWAY_EMBEDDING_MODEL', fallback: 'openai/text-embedding-3-small', description: 'Persona knowledge search' },
  speech: { env: 'AI_GATEWAY_TTS_MODEL', fallback: 'openai/tts-1', description: 'AI Gateway voices' },
  openaiText: { env: 'OPENAI_MODEL', fallback: 'gpt-4o-mini', description: 'Direct OpenAI text provider' },
  openaiSpeech: { env: 'OPENAI_TTS_MODEL', fallback: 'gpt-4o-mini-tts', description: 'Direct OpenAI voices' },
  elevenlabs: { env: 'ELEVENLABS_MODEL', fallback: 'eleven_multilingual_v2', description: 'ElevenLabs voices' }
};

export function modelFor(purpose) {
  const entry = PURPOSES[purpose];
  if (!entry) throw new Error(`Unknown model purpose: ${purpose}`);
  return process.env[entry.env] || (entry.inherit ? modelFor(entry.inherit) : entry.fallback);
}

export function fallbackModels(kind = 'text', primary = '') {
  const raw = kind === 'vision' ? process.env.AI_GATEWAY_VISION_FALLBACK_MODELS : process.env.AI_GATEWAY_FALLBACK_MODELS;
  return String(raw || DEFAULT_VISION).split(',').map(value => value.trim()).filter(value => value && value !== primary);
}

export function modelConfiguration() {
  return Object.fromEntries(Object.entries(PURPOSES).map(([purpose, entry]) => [purpose, { model: modelFor(purpose), env: entry.env, overridden: Boolean(process.env[entry.env]), description: entry.description }]));
}

// Rough USD prices for cost estimates (per million tokens, per million characters of speech).
// Override with MODEL_PRICES_JSON, e.g. {"google/gemini-2.5-flash-lite":{"input":0.1,"output":0.4}}.
const PRICES = {
  'google/gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'google/gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'openai/text-embedding-3-small': { input: 0.02, output: 0 },
  'openai/tts-1': { characters: 15 },
  'openai/gpt-4o-mini-tts': { characters: 12 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o-mini-tts': { characters: 12 },
  eleven_multilingual_v2: { characters: 180 }
};

export function estimateCost({ model, inputTokens = 0, outputTokens = 0, characters = 0 }) {
  let custom = {};
  try { custom = JSON.parse(process.env.MODEL_PRICES_JSON || '{}'); } catch {}
  const price = custom[model] || PRICES[model] || {};
  return ((price.input || 0) * inputTokens + (price.output || 0) * outputTokens + (price.characters || 0) * characters) / 1e6;
}
