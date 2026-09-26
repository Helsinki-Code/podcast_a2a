import './env.mjs';
import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import { account, accountByCustomer, grantCredits, recordWebhookEvent, setStripeCustomer, updateSubscription } from './store.mjs';

let stripeClient;
export function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured.');
  stripeClient ||= new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-08-26.dahlia' });
  return stripeClient;
}

export const plans = {
  starter: { name: 'Starter', monthly: 99, credits: 100, priceId: () => process.env.STRIPE_PRICE_STARTER },
  pro: { name: 'Pro', monthly: 249, credits: 300, priceId: () => process.env.STRIPE_PRICE_PRO },
  scale: { name: 'Scale', monthly: 599, credits: 1000, priceId: () => process.env.STRIPE_PRICE_SCALE }
};
export const costs = { podcast: 20, explainer: 30, explainerRerender: 10, shorts: 5, translation: 2, dubPodcast: 20, dubExplainer: 10 };
// One-time credit packs, bought outside the monthly plan. Priced inline so no Stripe price IDs are needed.
export const topUps = {
  small: { name: '50 credits', credits: 50, amount: 5900 },
  medium: { name: '150 credits', credits: 150, amount: 15900 },
  large: { name: '500 credits', credits: 500, amount: 47900 }
};
export const publicTopUps = () => Object.entries(topUps).map(([id, pack]) => ({ id, name: pack.name, credits: pack.credits, price: pack.amount / 100 }));
export const LOW_CREDIT_THRESHOLD = 30;

export const isPaid = item => ['active', 'trialing'].includes(item?.subscriptionStatus);

export function publicPlans() {
  return Object.entries(plans).map(([id, item]) => ({ id, name: item.name, monthly: item.monthly, credits: item.credits }));
}

export function planForPrice(priceId) {
  return Object.entries(plans).find(([, item]) => item.priceId() === priceId)?.[0] || 'none';
}

async function ensureCustomer(userId, email) {
  const current = await account(userId, email);
  if (current.stripeCustomerId) return current.stripeCustomerId;
  const customer = await stripe().customers.create({ email: email || undefined, metadata: { sales_forge_user_id: userId } }, { idempotencyKey: `sales-forge-customer-${userId}` });
  await setStripeCustomer(userId, customer.id);
  return customer.id;
}

export async function createCheckout(userId, email, planId) {
  const selected = plans[planId];
  if (!selected?.priceId()) throw new Error('Choose a valid subscription plan.');
  const customer = await ensureCustomer(userId, email);
  const suffix = randomBytes(8).toString('hex').replace(/[^a-z]/g, '').slice(0, 8).padEnd(8, 'a');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://dsalesforge.online';
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription', customer, client_reference_id: userId,
    line_items: [{ price: selected.priceId(), quantity: 1 }],
    success_url: `${appUrl}/?billing=success`, cancel_url: `${appUrl}/?billing=cancelled`,
    allow_promotion_codes: true, integration_identifier: `sales_forge_${suffix}`,
    subscription_data: { metadata: { sales_forge_user_id: userId, plan: planId } }
  });
  return session.url;
}

export async function createTopUpCheckout(userId, email, packId) {
  const pack = topUps[packId];
  if (!pack) throw new Error('Choose a valid credit pack.');
  const customer = await ensureCustomer(userId, email);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://dsalesforge.online';
  const session = await stripe().checkout.sessions.create({
    mode: 'payment', customer, client_reference_id: userId,
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: pack.amount, product_data: { name: `The Sales Forge — ${pack.name}`, description: 'One-time credit top-up. Credits never expire while your plan is active.' } } }],
    metadata: { sales_forge_user_id: userId, sales_forge_topup: packId, credits: String(pack.credits) },
    payment_intent_data: { metadata: { sales_forge_user_id: userId, sales_forge_topup: packId } },
    success_url: `${appUrl}/?billing=topup`, cancel_url: `${appUrl}/?billing=cancelled`
  });
  return session.url;
}

export async function createPortal(userId) {
  const current = await account(userId);
  if (!current.stripeCustomerId) throw new Error('No billing account exists yet.');
  const session = await stripe().billingPortal.sessions.create({ customer: current.stripeCustomerId, return_url: process.env.NEXT_PUBLIC_APP_URL || 'https://dsalesforge.online', ...(process.env.STRIPE_PORTAL_CONFIGURATION ? { configuration: process.env.STRIPE_PORTAL_CONFIGURATION } : {}) });
  return session.url;
}

function subscriptionFields(subscription) {
  const priceId = subscription.items?.data?.[0]?.price?.id || null;
  return {
    stripeSubscriptionId: subscription.id,
    stripePriceId: priceId,
    plan: planForPrice(priceId),
    subscriptionStatus: subscription.status,
    periodEnd: subscription.items?.data?.[0]?.current_period_end ? new Date(subscription.items.data[0].current_period_end * 1000).toISOString() : null
  };
}

async function syncSubscription(subscription) {
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  let current = await resolveAccount(customerId);
  const fallbackUser = subscription.metadata?.sales_forge_user_id;
  if (!current && fallbackUser) { await account(fallbackUser); await setStripeCustomer(fallbackUser, customerId); current = await account(fallbackUser); }
  if (current) await updateSubscription(current.userId, subscriptionFields(subscription));
  return current;
}

async function resolveAccount(customerId) {
  let current = await accountByCustomer(customerId);
  if (current || !customerId) return current;
  const customer = await stripe().customers.retrieve(customerId);
  const userId = !customer.deleted && customer.metadata?.sales_forge_user_id;
  if (!userId) return null;
  await account(userId, !customer.deleted ? customer.email || '' : '');
  await setStripeCustomer(userId, customerId);
  return account(userId);
}

export async function processStripeWebhook(raw, signature) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is not configured.');
  const event = stripe().webhooks.constructEvent(raw, signature, process.env.STRIPE_WEBHOOK_SECRET);
  const object = event.data.object;
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const userId = object.client_reference_id;
    const customerId = typeof object.customer === 'string' ? object.customer : object.customer?.id;
    if (userId && customerId) { await account(userId); await setStripeCustomer(userId, customerId); }
    // Credit packs are granted once, and only after the payment has actually cleared.
    const packId = object.metadata?.sales_forge_topup;
    if (userId && object.mode === 'payment' && topUps[packId] && object.payment_status === 'paid') await grantCredits(userId, topUps[packId].credits, 'topup', object.id, `topup:${object.id}`);
    if (object.subscription) await syncSubscription(await stripe().subscriptions.retrieve(typeof object.subscription === 'string' ? object.subscription : object.subscription.id));
  } else if (event.type.startsWith('customer.subscription.')) {
    await syncSubscription(object);
  } else if (event.type === 'invoice.paid') {
    const customerId = typeof object.customer === 'string' ? object.customer : object.customer?.id;
    const current = await resolveAccount(customerId);
    const line = object.lines?.data?.find(item => item.price?.id) || object.lines?.data?.[0];
    const priceId = line?.price?.id || line?.pricing?.price_details?.price;
    const planId = planForPrice(typeof priceId === 'string' ? priceId : priceId?.id);
    if (current && plans[planId]) await grantCredits(current.userId, plans[planId].credits, 'subscription_cycle', object.id, `invoice:${object.id}`);
  } else if (event.type === 'invoice.payment_failed') {
    const customerId = typeof object.customer === 'string' ? object.customer : object.customer?.id;
    const current = await resolveAccount(customerId);
    if (current) await updateSubscription(current.userId, { ...current, subscriptionStatus: 'past_due' });
  }
  await recordWebhookEvent(event.id);
  return { received: true };
}
