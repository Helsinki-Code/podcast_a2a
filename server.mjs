import './lib/env.mjs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initStore, account, usesRemoteAssets } from './lib/store.mjs';
import { authenticate } from './lib/auth.mjs';
import { costs, isPaid, processStripeWebhook, publicPlans } from './lib/billing.mjs';
import { availableProviders } from './lib/providers.mjs';
import { environmentReport } from './lib/environment.mjs';
import { json, error, rawBody, staticFile } from './lib/http.mjs';
import * as accountRoutes from './routes/account.mjs';
import * as assetRoutes from './routes/assets.mjs';
import * as personaRoutes from './routes/personas.mjs';
import * as episodeRoutes from './routes/episodes.mjs';
import * as explainerRoutes from './routes/explainers.mjs';
import * as publishingRoutes from './routes/publishing.mjs';
import * as publicRoutes from './routes/public.mjs';

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
    const auth = await authenticate(req);
    if (!auth) return error(res, 401, 'Sign in to The Sales Forge.');
    const userAccount = await account(auth.userId);
    const context = { req, res, url, parts, auth, userAccount };
    if (await accountRoutes.handleUnpaid(context)) return;
    if (!isPaid(userAccount)) return error(res, 402, 'A paid The Sales Forge subscription is required.');
    for (const routes of paidRoutes) if (await routes.handle(context)) return;
    error(res, 404, 'Not found');
  } catch (cause) { error(res, 400, cause.message || 'Request failed'); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3377);
  http.createServer(handler).listen(port, process.env.HOST || '127.0.0.1', () => console.log(`The Sales Forge: http://${process.env.HOST || '127.0.0.1'}:${port}`));
}