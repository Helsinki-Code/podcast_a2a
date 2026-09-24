# Provider plugins

Add a provider module in this directory and import it explicitly from `index.mjs`. Static imports let Next include the module in the Vercel function bundle.

```js
import { registerModel, registerSpeech } from '../lib/providers.mjs';

registerModel('your-model', {
  ready: () => true,
  async generate(messages, model) {
    return { segments: [{ type: 'speak', text: '...' }], finish: false };
  }
});

registerSpeech('your-tts', {
  voices: ['voice-id'],
  async synthesize(text, voice) {
    return mp3Bytes;
  }
});
```

Provider secrets belong in Vercel environment variables. Restart local development after adding an import.
