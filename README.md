# Live Podcast Studio

An AI-to-AI podcast production workspace built from the [full build spec](./AI%20Podcast%20Platform%20%E2%80%94%20Full%20Build%20Spec%20%28v0.0.0.1%29.md). Create reusable host and guest personas, attach private knowledge files, set a host-only topic outline, and record an unscripted conversation with live sandbox demonstrations.

## Start

Requires Node.js 22 or newer and `ffmpeg` for MP4 export.

```bash
npm install
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`. Set `E2B_API_KEY` to enable isolated code, browser, and file tools. An E2B custom template with Python, Node.js, Playwright, Chromium, and curl installed will make browser starts much faster; set its ID as `E2B_TEMPLATE`. Without a template, the browser tool installs Playwright and Chromium in that episode's sandbox on first use.

```bash
npm start
```

Open [http://127.0.0.1:3377](http://127.0.0.1:3377). The server binds to localhost by default. Data is stored in `data/` and is ignored by Git.

## Production flow

1. Create at least two personas. Each gets its own prompt, text/PDF/DOCX knowledge files, model provider, speech provider and voice, and an optional display image. The retrieval layer indexes each file in chunks and selects relevant passages on every turn.
2. Create an episode, choosing the host, guest, private host outline, optional host tool access, interjection setting, visual layout, colors, glow, pane width, resolution, output format, and a duration safety limit. The episode keeps a snapshot of both personas as they were at creation time.
3. In the episode studio, click **Start recording**. Keep the studio tab open for the full take. Browser playback acknowledges each spoken segment before the next segment begins, so the recorded timing matches what plays.
4. Review the take in the studio or download the transcript, episode data, WebM master, or MP4 export when the episode completes. MP4 requires `ffmpeg`; WebM remains available if conversion fails.

The host receives the private outline. The guest receives only the subject, transcript, its own prompt and retrieved knowledge, and the currently visible sandbox state. Neither receives the other's prompt or files. The host decides when to close naturally; the duration setting is a safety limit rather than a fixed turn count.

Speech is synthesized in short utterances and its MP3 chunks are sent to playback as they arrive. The browser connects playback to a Web Audio analyser and the canvas recorder, so the speaking glow uses live audio amplitude. The video recorder captures the stage continuously from start to finish. Browser and terminal outputs are stored as events with timestamps alongside each episode.

## Sandbox tools

Code runs Python or JavaScript in an episode-scoped E2B microVM. Browser actions use a persistent Playwright page inside that same microVM and return screenshots. Diagram actions render SVG; file actions create text, data, or SVG artifacts in the isolated filesystem and store copies for review. Agents can also play an MP3, WAV, or OGG file created inside the microVM; that sound is mixed into the continuous recording. The microVM is killed at episode end. No AI-generated code runs on the studio host.

Each action emits start, partial output where available, and completion events. The other persona may fill longer tool waits with a live reaction. New tool types and providers can be registered through [`plugins/README.md`](./plugins/README.md).

## Operational limits

- A browser tab must stay open during recording; a disconnected playback client ends the run after a timeout.
- The service is designed for a trusted local operator. It has no user accounts or public deployment security layer.
- API keys for live OpenAI/E2B integration are not bundled. The automated test suite covers orchestration and retrieval with local provider doubles. A real provider run needs your own keys.
- Images are limited to 3 MB; knowledge uploads to 5 MB each; each extracted document is capped at 250,000 characters.

Run tests with `npm test`.
