import './lib/env.mjs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initStore, account, usesRemoteAssets, membershipFor } from './lib/store.mjs';
import { authenticate } from './lib/auth.mjs';
import { costs, isPaid, processStripeWebhook, publicPlans } from './lib/billing.mjs';
import { availableProviders } from './lib/providers.mjs';
import { environmentReport } from './lib/environment.mjs';
import { captureError } from './lib/monitor.mjs';
import { checkRateLimit } from './lib/rate-limit.mjs';
import { json, error, rawBody, staticFile } from './lib/http.mjs';
import * as accountRoutes from './routes/account.mjs';
import * as assetRoutes from './routes/assets.mjs';
import * as personaRoutes from './routes/personas.mjs';
import * as episodeRoutes from './routes/episodes.mjs';
import * as explainerRoutes from './routes/explainers.mjs';
import * as publishingRoutes from './routes/publishing.mjs';
import * as publicRoutes from './routes/public.mjs';
import * as teamRoutes from './routes/team.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let initialization;
function ensureInitialized() {
  initialization ||= (async () => {
    await initStore();
    await import('./plugins/index.mjs');
  })();
  return initialization;
}

// Paid-workspace routes, tried in order; each module returns true once it has responded.
const paidRoutes = [accountRoutes, assetRoutes, personaRoutes, publishingRoutes, episodeRoutes, explainerRoutes];

export async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    if (['/health', '/api/health'].includes(url.pathname) && req.method === 'GET') return json(res, 200, { ok: true, environment: environmentReport() });
    if (url.pathname === '/' && req.method === 'GET') return staticFile(req, res, path.join(here, 'public'), 'index.html');
    if (url.pathname === '/favicon.ico' && req.method === 'GET') return staticFile(req, res, path.join(here, 'public'), 'favicon.ico');
    if (url.pathname === '/privacy' && req.method === 'GET') return staticFile(req, res, path.join(here, 'public'), 'privacy.html');
    if (url.pathname === '/terms' && req.method === 'GET') return staticFile(req, res, path.join(here, 'public'), 'terms.html');
    if (parts[0] === 'public' && req.method === 'GET') return staticFile(req, res, path.join(here, 'public'), parts.slice(1).join('/'));
    if (url.pathname === '/api/config' && req.method === 'GET') {
      const providers = availableProviders();
      return json(res, 200, { brand: 'The Sales Forge', clerkPublishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || '', plans: publicPlans(), costs, providers, storage: { remoteAssets: usesRemoteAssets() }, realtime: process.env.VERCEL ? 'poll' : 'sse', ready: { model: Object.values(providers.ready.models).some(Boolean), sandbox: !!(process.env.VERCEL || process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL_TOKEN) }, environment: environmentReport() });
    }
    await ensureInitialized();
    if (url.pathname === '/api/webhooks/stripe' && req.method === 'POST') {
      const raw = await rawBody(req, 2_000_000);
      return json(res, 200, await processStripeWebhook(raw, req.headers['stripe-signature'] || ''));
    }
    if (await publicRoutes.handle({ req, res, url, parts })) return;
    const session = await authenticate(req);
    if (!session) return error(res, 401, 'Sign in to The Sales Forge.');
    // Team members act inside the owner's workspace: auth.userId is that scope, actorId the person.
    const membership = await membershipFor(session.userId);
    const auth = { ...session, actorId: session.userId, userId: membership?.ownerId || session.userId, role: membership?.role || 'owner', teamName: membership?.teamName || '' };
    const limited = await checkRateLimit(auth.actorId, req.method, url.pathname);
    if (limited) {
      res.setHeader('Retry-After', String(limited.retryAfter));
      return json(res, 429, { error: `Too many requests (${limited.rule}). Try again in ${Math.ceil(limited.retryAfter / 60)} minutes.` });
    }
    const userAccount = await account(auth.userId);
    const context = { req, res, url, parts, auth, userAccount };
    if (await teamRoutes.handle(context)) return;
    if (auth.role === 'viewer' && !['GET', 'HEAD'].includes(req.method) && !url.pathname.startsWith('/api/team/')) return error(res, 403, 'Viewers can watch and download but not create or change anything. Ask an admin for editor access.');
    if (auth.role !== 'owner' && /^\/api\/billing\//.test(url.pathname)) return error(res, 403, 'Only the workspace owner manages billing.');
    if (await accountRoutes.handleUnpaid(context)) return;
    if (!isPaid(userAccount)) return error(res, 402, 'A paid The Sales Forge subscription is required.');
    for (const routes of paidRoutes) if (await routes.handle(context)) return;
    error(res, 404, 'Not found');
  } catch (cause) {
    // Validation errors are expected; programming errors (TypeError etc.) are reported.
    if (cause instanceof TypeError || cause instanceof ReferenceError || cause instanceof RangeError || cause instanceof SyntaxError && !/JSON/.test(cause.message)) captureError(cause, { route: `${req.method} ${req.url?.split('?')[0]}` });
    error(res, 400, cause.message || 'Request failed');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3377);
  process.on('unhandledRejection', reason => captureError(reason instanceof Error ? reason : new Error(String(reason)), { source: 'unhandledRejection' }));
  http.createServer(handler).listen(port, process.env.HOST || '127.0.0.1', () => console.log(`The Sales Forge: http://${process.env.HOST || '127.0.0.1'}:${port}`));
}