# AI Podcast Platform — Full Build Spec (v0.0.0.1)

2026-09-19 · @Someone

Complete feature specification for an AI-to-AI live podcast platform: two autonomous AI agents (Host + Guest) hold a fully unscripted, unprepared conversation, with either persona able to invoke a live multi-modal sandbox mid-conversation, captured as a single continuous take and compiled into a video for YouTube.

## 1. Core Concept & Premise

- Two autonomous AI agents — a **Host** and a **Guest** — conduct a fully unscripted, live-feeling conversation for a video podcast. Every line is generated live in response to what the other agent just said. No pre-written dialogue, no fixed script, no fixed turn count.
- The Host receives only a topic outline before the conversation starts (subject, rough angle, a handful of discussion points) — no knowledge of the Guest's specific answers or material in advance.
- The Guest receives zero information about the Host's planned question sequence. It only has its own persona (system prompt + ingested knowledge files) and general awareness of the topic.
- The system supports a Guest that is either a custom AI agent built by a user, or — in specific configurations — a Host built the same way, for guest-hosted episode formats.
- Output: a recorded, single continuous take (no manual retakes or edits at the conversation level) capturing audio, visual state, and any sandbox activity, compiled into a video file ready for YouTube upload.

## 2. Agent & Persona System

- A **Persona Builder** lets a user create any Host or Guest agent by supplying: (1) a system prompt defining personality, speaking style, expertise, and role; (2) one or more knowledge files (documents, transcripts, notes, data) ingested for that persona; (3) a selected voice, assigned from the connected voice provider(s); (4) a display image used for that persona's on-screen presence.
- Knowledge files are ingested into a per-persona retrieval index (RAG) queried live during generation, so persona knowledge is grounded in the actual material, not just crammed into a static prompt.
- Persona creation is fully dynamic and reusable: any persona built once can be selected as Host or Guest in any future episode. Personas are swappable per episode through configuration — no persona, prompt, or voice is hardcoded into the system.
- Each persona's system prompt and knowledge base are private to that persona: the Host's instructions and materials are never exposed to the Guest, and vice versa — this is what preserves the no-prep dynamic from Section 1.

## 3. Conversation Orchestration Engine

- Turn-taking is decided by an explicit **turn broker**, not by real-time voice-activity detection. The broker holds conversation state as a sequence of turns and decides who speaks next.
- Default flow: strict alternation between Host and Guest, with an **interject mechanic** layered on top. While one persona is speaking, the other persona's controller evaluates the in-progress transcript against configurable interruption triggers (semantic relevance, direct address, strong agreement/disagreement signals, or a tunable base probability) and may request an interrupt — cutting the current speaker's audio at the nearest natural word boundary and handing over the turn.
- A turn is not limited to speech. A turn can be a sequence of `speak → act (sandbox tool call) → speak → act …`, fully interleaved, so a persona narrates while and around acting — never silently completing a multi-step tool sequence before saying anything about it.
- When a turn involves a sandbox action that takes real time (code running, a page loading, content generating), the orchestrator has the acting persona narrate through the wait, or prompts the other persona to speak or ask a question during that window. Dead silence beyond a short threshold is not an acceptable state.
- The orchestrator exposes the full conversation history (as text) plus the live sandbox state (current tool output, current screen content) to whichever persona is about to generate its next turn, so reactions to on-screen content are grounded in what is actually displayed at that moment.
- No part of the conversation flow is pre-scripted or templated. The orchestrator decides structure — who speaks, when, whether to interject, whether to reach for the sandbox — dynamically from live model output on every turn, for every episode, regardless of topic or personas involved.

## 4. Voice & Audio Pipeline

- Each persona's spoken lines are generated as text by its underlying model, then converted to speech using its assigned voice, per turn segment — at low enough latency to keep the interleaved speak/act flow from Section 3 moving.
- The audio pipeline is provider-agnostic: any TTS provider can be plugged in per persona through a common interface, selectable at persona-creation time. No single vendor is hardcoded into the system.
- Audio output for each persona is delivered as a stream, not just a final file, so the visual layer can read live amplitude for the speaking indicator in sync with playback.
- Full episode audio — both personas plus any sandbox-related sound — is mixed and captured continuously for the final export.

## 5. Visual Layer

- Each persona is represented on screen by a static, user-uploaded display image — no avatar animation, lip-sync, or facial modeling.
- While a persona is speaking, its image shows a real-time glow/pulse effect driven directly by that persona's live audio amplitude, so visual emphasis tracks who is actually talking at every moment.
- The screen layout includes the two persona images (with speaking indicators) plus a dedicated **sandbox pane** that activates and expands when a persona is using a tool, similar to a screen-share layout — minimized or hidden when not in active use.
- All visual elements — persona images, glow styling, sandbox pane, layout proportions — are configurable per episode, not hardcoded to one look.

## 6. Multi-Modal Sandbox System

- Either persona (Guest by default, Host when configured) can invoke a live sandbox mid-conversation to demonstrate real work. The initial build covers all of the following modalities:
  1. **Code/terminal execution** — run and display real code output live.
  2. **Browser automation** — navigate and interact with real web pages live, streaming the resulting page/screenshots to the sandbox pane.
  3. **Diagram/whiteboard rendering** — draw and update diagrams, flowcharts, or freeform sketches live to illustrate a concept.
  4. **File/artifact creation** — generate and display documents, images, or data files live as part of an explanation.
- The sandbox runs in an isolated, securely sandboxed execution environment (microVM-level isolation) so that any code, browser action, or file operation triggered by a persona during a live-recorded episode cannot affect the host system or any other episode's environment.
- Each sandbox action streams its live output (terminal text, rendered visuals, browser frames, generated files) to the sandbox pane in near-real time as it happens, synchronized with the acting persona's narration.
- The tool system is built as an extensible framework: new tool/sandbox modalities can be added later without redesigning the orchestrator or the persona system, since Guest content is not restricted to a fixed set of topics or demo types — the platform accepts whatever tool a given episode's content calls for.
- Sandbox sessions are scoped per episode: each episode gets a fresh, isolated environment, with no state carried over between episodes.

## 7. Shared Context & Awareness

- Every persona's turn-generation call receives: the full conversation transcript so far, the live/current state of the sandbox pane (whatever's on screen right now, including any error, result, or partial output), and its own persona knowledge base — so a reaction such as "wait, what's that error on line 12?" is grounded in what's actually visible at that moment, not a stale summary.
- The Host's outline (its only prior information) and the Guest's persona knowledge base remain separate, private context inputs — never shared with the other persona — preserving the no-prior-prep dynamic throughout the episode.
- Context assembly happens fresh for every turn, pulling the latest transcript and sandbox state, so long tool-use sequences never cause either persona to generate off stale information.

## 8. Recording & Output Pipeline

- The full episode — audio from both personas, the visual layer (images + glow), and all sandbox pane activity — is captured continuously in one unbroken pass from episode start to end, with no manual cuts or edits at the conversation level.
- The system compiles the captured audio, visual layer, and sandbox pane recording into a single synchronized video file, timed exactly to when each event occurred during generation.
- Output format and resolution are configurable, targeting direct upload readiness for YouTube.
- Each episode's raw components — persona configs used, transcript, sandbox action log, final video — are stored and retrievable, so any episode can be reviewed or reused as reference when building new personas.

## 9. Extensibility & Configuration Requirements

- Nothing in the system is hardcoded to a specific topic, persona, voice, tool, or conversation shape. Every persona, topic outline, voice assignment, and sandbox modality used in a given episode is a configuration input, not code.
- The system handles any subject matter or demo type a user's Guest or Host persona is built for — the sandbox and orchestration layers make no assumption about a fixed content domain, whether that's a coding demo, a market analysis walkthrough, a design critique, or a philosophical debate.
- Adding a new sandbox tool type, a new TTS provider, or a new persona requires configuration/plugin registration only — never changes to the core orchestration or rendering logic.
- The platform supports running multiple distinct episodes (different persona pairs, different topics, different sandbox needs) side by side, with no manual reconfiguration of the core system between them.
