# Provider and tool plugins

The server imports every `*.mjs` file in this directory at startup. A plugin can register a model, speech provider, or sandbox tool without changing the orchestrator or studio renderer.

```js
import { registerModel, registerSpeech } from '../lib/providers.mjs';
import { registerTool } from '../lib/sandbox.mjs';

registerModel('your-model', {
  async generate(messages, model) {
    // Return the same JSON structure requested in the system message.
    return { segments: [{ type: 'speak', text: '...' }], finish: false };
  }
});

registerSpeech('your-tts', {
  voices: ['voice-id'],
  async synthesize(text, voice) {
    // Return MP3 bytes as a Buffer or an async iterable of chunks.
    // Streaming chunks start playback before synthesis is finished.
    return providerResponse.body;
  }
});

registerTool('your-tool', async (episodeSandbox, input) => {
  // Use episodeSandbox.ensure() for work in its isolated E2B microVM.
  // Return a screen object; the studio renders its title, content and image.
  return { type: 'file', title: 'Result', content: 'Visible output' };
});
```

Place secrets in `.env`, never in persona prompts or browser code. Restart the server after adding a plugin.
