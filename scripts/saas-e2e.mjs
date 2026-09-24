import '../lib/env.mjs';
import { createClerkClient } from '@clerk/backend';
import Stripe from 'stripe';
import { neon } from '@neondatabase/serverless';
import { account } from '../lib/store.mjs';
import { readFile } from 'node:fs/promises';

if (process.env.CLERK_E2E_ENV_FILE) {
  for (const line of (await readFile(process.env.CLERK_E2E_ENV_FILE, 'utf8')).split('\n')) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

const base = process.env.SALES_FORGE_E2E_URL || 'http://127.0.0.1:3380';
const suffix = Date.now();
const email = `sales-forge-check-${suffix}@example.com`;
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY, publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-08-26.dahlia' });
const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
let user, session, customerId;

async function call(path, token, options = {}) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} returned ${response.status}: ${data.error || JSON.stringify(data)}`);
  return data;
}
async function webhook(type, object) {
  const payload = JSON.stringify({ id: `evt_sales_forge_${type.replaceAll('.', '_')}_${suffix}`, object: 'event', api_version: '2026-08-26.dahlia', created: Math.floor(Date.now() / 1000), livemode: false, pending_webhooks: 1, type, data: { object } });
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  return call('/api/webhooks/stripe', null, { method: 'POST', body: payload, headers: { 'stripe-signature': signature } });
}

try {
  user = await clerk.users.createUser({ emailAddress: [email], firstName: 'Deployment', lastName: 'Check', password: `Forge-${suffix}-Safe!`, skipPasswordChecks: true, skipLegalChecks: true });
  session = await clerk.sessions.createSession({ userId: user.id });
  const token = (await clerk.sessions.getToken(session.id)).jwt;
  const firstMe = await call('/api/auth/me', token);
  if (firstMe.account.subscriptionStatus !== 'none' || firstMe.account.credits !== 0) throw new Error('New accounts must start outside the paid workspace with zero credits.');
  const denied = await fetch(`${base}/api/personas`, { headers: { Authorization: `Bearer ${token}` } });
  if (denied.status !== 402) throw new Error(`Unpaid workspace request returned ${denied.status}, expected 402.`);
  const checkout = await call('/api/billing/checkout', token, { method: 'POST', body: JSON.stringify({ plan: 'starter' }) });
  if (!checkout.url?.startsWith('https://checkout.stripe.com/')) throw new Error('Checkout URL was not returned.');
  const current = await account(user.id, email); customerId = current.stripeCustomerId;
  if (!customerId) throw new Error('Stripe customer was not mapped to the Clerk user.');
  const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
  await webhook('customer.subscription.created', { id: `sub_sales_forge_${suffix}`, object: 'subscription', customer: customerId, status: 'active', metadata: { sales_forge_user_id: user.id, plan: 'starter' }, items: { data: [{ price: { id: process.env.STRIPE_PRICE_STARTER }, current_period_end: periodEnd }] } });
  await webhook('invoice.paid', { id: `in_sales_forge_${suffix}`, object: 'invoice', customer: customerId, lines: { data: [{ price: { id: process.env.STRIPE_PRICE_STARTER } }] } });
  const paid = await call('/api/auth/me', token);
  if (paid.account.subscriptionStatus !== 'active' || paid.account.credits !== 100) throw new Error(`Expected active Starter with 100 credits, got ${paid.account.subscriptionStatus}/${paid.account.credits}.`);
  const host = await call('/api/personas', token, { method: 'POST', body: JSON.stringify({ name: 'E2E Host', systemPrompt: 'Interview product experts clearly.', modelProvider: 'gateway', speechProvider: 'gateway', voice: 'alloy' }) });
  const guest = await call('/api/personas', token, { method: 'POST', body: JSON.stringify({ name: 'E2E Guest', systemPrompt: 'Explain product workflows clearly.', modelProvider: 'gateway', speechProvider: 'gateway', voice: 'coral' }) });
  await call('/api/episodes', token, { method: 'POST', body: JSON.stringify({ hostId: host.id, guestId: guest.id, outline: { subject: 'Deployment verification' }, settings: { outputFormat: 'webm', demo: {} } }) });
  await call('/api/explainers', token, { method: 'POST', body: JSON.stringify({ title: 'Deployment verification', url: 'https://example.com', brief: 'Explain the example page and its primary purpose to a prospective customer.', authRequired: false }) });
  const [personas, episodes, explainers] = await Promise.all([call('/api/personas', token), call('/api/episodes', token), call('/api/explainers', token)]);
  if (personas.length !== 2 || episodes.length !== 1 || explainers.length !== 1) throw new Error('Owner-scoped content lists did not return the expected records.');
  console.log('saas e2e verified: Clerk auth, unpaid lock, Stripe checkout/webhooks, credits, podcasts, explainers, owner scope');
} finally {
  if (user?.id) {
    await sql`DELETE FROM platform_explainers WHERE owner_id = ${user.id}`.catch(() => {});
    await sql`DELETE FROM podcast_episodes WHERE document->>'ownerId' = ${user.id}`.catch(() => {});
    await sql`DELETE FROM podcast_personas WHERE document->>'ownerId' = ${user.id}`.catch(() => {});
    await sql`DELETE FROM sales_forge_credit_ledger WHERE user_id = ${user.id}`.catch(() => {});
    await sql`DELETE FROM sales_forge_accounts WHERE user_id = ${user.id}`.catch(() => {});
  }
  if (customerId) {
    const sessions = await stripe.checkout.sessions.list({ customer: customerId, limit: 10 }).catch(() => ({ data: [] }));
    for (const item of sessions.data) if (item.status === 'open') await stripe.checkout.sessions.expire(item.id).catch(() => {});
    await stripe.customers.del(customerId).catch(() => {});
  }
  if (session?.id) await clerk.sessions.revokeSession(session.id).catch(() => {});
  if (user?.id) await clerk.users.deleteUser(user.id).catch(() => {});
}
