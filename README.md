# The Sales Forge

The Sales Forge is a paid AI product media studio at [dsalesforge.online](https://dsalesforge.online). It produces two kinds of downloadable video:

- AI-to-AI podcasts with distinct host and guest personas, private knowledge, live speech, captions, and screenshot-driven Computer Use demonstrations.
- 1080p platform explainers where an isolated browser signs into an application, follows the requested workflow, records the screen, narrates the product, burns subtitles into the MP4, and provides a caption file.

There is no free workspace. Clerk authenticates users, Stripe Billing controls access, and every successful invoice grants the plan’s monthly credits.

## Plans and credit costs

| Plan | Monthly price | Monthly credits |
| --- | ---: | ---: |
| Starter | $99 | 100 |
| Pro | $249 | 300 |
| Scale | $599 | 1,000 |

A podcast costs 20 credits. A platform explainer costs 30 credits. Credit reservations are idempotent, and a workflow failure refunds its reservation once.

## Production architecture

- Clerk provides production authentication and account management.
- Stripe Checkout creates subscriptions. Signed Stripe webhooks update subscription state and grant credits after paid invoices. Stripe’s customer portal handles payment methods, invoices, and cancellation.
- Vercel Workflow runs podcast and explainer jobs as durable steps.
- Vercel AI Gateway routes separate host, guest, interjection, and multimodal explainer calls with per-feature usage tags and model fallbacks. Gemini 2.5 Flash Lite is the default conversational model; Gemini 3.1 Flash Lite directs screenshot-based walkthroughs.
- Vercel Sandbox runs a persistent 1920×1080 Linux desktop with Xvnc, Openbox, noVNC, Chrome, xdotool, ImageMagick, Agent Browser, ffmpeg 7, and ffprobe.
- The visual explainer director receives the current screenshot, accessibility tree, completed actions, rejected choices, and requested/completed/remaining milestones. It chooses each next action dynamically. The executor validates safety, drives real mouse and keyboard input, records the action, and rejects repeated, frozen, or incomplete scenes.
- Podcast host and guest decisions use their own model routes. After a live browser action, the guest model receives the actual screenshot and returns podcast `segments`; explainer and podcast visual contracts are kept separate.
- FFmpeg deterministically creates downloadable H.264/AAC MP4 and SRT assets from the event timeline. Generation waits are excluded, browser clips are preserved, action footage is aligned to narration, and media probes reject broken timestamps, missing streams, frozen video, and excessive silence.
- Neon stores owner-scoped personas, episodes, explainers, accounts, credit ledger entries, and processed webhook IDs.
- Private Vercel Blob stores speech, captures, subtitles, and finished videos.

Credentials entered for an authenticated demonstration go directly to the isolated browser login flow. Passwords are not stored in Neon and are not sent to the model. MFA, CAPTCHA, and custom sign-in flows can be completed through the interactive noVNC desktop before recording. Users must only provide credentials for applications they are authorized to access.

## Required environment variables

```dotenv
NEXT_PUBLIC_APP_URL=https://dsalesforge.online
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
STRIPE_SECRET_KEY=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_STARTER=
STRIPE_PRICE_PRO=
STRIPE_PRICE_SCALE=
STRIPE_PORTAL_CONFIGURATION=
DATABASE_URL=
BLOB_READ_WRITE_TOKEN=
AGENT_BROWSER_SNAPSHOT_ID=
COMPUTER_USE_SNAPSHOT_ID=
AI_GATEWAY_MODEL=google/gemini-2.5-flash-lite
AI_GATEWAY_HOST_MODEL=google/gemini-2.5-flash-lite
AI_GATEWAY_GUEST_MODEL=google/gemini-2.5-flash-lite
AI_GATEWAY_ROUTER_MODEL=google/gemini-2.5-flash-lite
EXPLAINER_MODEL=google/gemini-3.1-flash-lite
AI_GATEWAY_COMPUTER_MODEL=google/gemini-3.1-flash-lite
AI_GATEWAY_FALLBACK_MODELS=google/gemini-3.1-flash-lite
AI_GATEWAY_VISION_FALLBACK_MODELS=google/gemini-3.1-flash-lite
```

Vercel supplies OIDC for AI Gateway and Sandbox in deployed environments. Local development can use `AI_GATEWAY_API_KEY`; direct OpenAI speech can use `OPENAI_API_KEY`.

## Local development

Requires Node.js 22 or newer.

```bash
npm install
vercel link
vercel env pull .env.local
npm run dev
```

The standalone server uses port 3377:

```bash
npm run build
PORT=3377 node server.mjs
```

## Verification

```bash
npm test
npm run build
node scripts/check-stripe-checkout.mjs
node scripts/check-explainer-render.mjs
node scripts/check-computer-use-input.mjs
node scripts/check-podcast-computer-use.mjs
node scripts/check-podcast-gateway-plan.mjs
node scripts/check-podcast-render.mjs
node scripts/check-explainer-workflow.mjs
node scripts/check-media-quality.mjs --interactive /path/to/video.mp4
```

`scripts/saas-e2e.mjs` creates a disposable Clerk development user and Stripe test checkout, verifies the unpaid lock, signed webhooks, credits, owner isolation, podcasts, and explainers, then deletes its records.

The original feature specification remains in [AI Podcast Platform — Full Build Spec (v0.0.0.1).md](./AI%20Podcast%20Platform%20%E2%80%94%20Full%20Build%20Spec%20%28v0.0.0.1%29.md).
