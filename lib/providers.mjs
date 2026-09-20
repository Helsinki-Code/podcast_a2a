export const modelProviders = new Map();
export const speechProviders = new Map();
export const registerModel = (name, provider) => modelProviders.set(name, provider);
export const registerSpeech = (name, provider) => speechProviders.set(name, provider);

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

export function availableProviders() { return {
  models: [...modelProviders.keys()], speech: [...speechProviders.keys()],
  voices: Object.fromEntries([...speechProviders].map(([name, provider]) => [name, provider.voices || []])),
  ready: { models: Object.fromEntries([...modelProviders].map(([name, provider]) => [name, provider.ready?.() !== false])), speech: Object.fromEntries([...speechProviders].map(([name, provider]) => [name, provider.ready?.() !== false])) }
}; }
