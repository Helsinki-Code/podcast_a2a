import '../lib/env.mjs';
import Stripe from 'stripe';
import { spawnSync } from 'node:child_process';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-08-26.dahlia' });
const plans = [
  { key: 'starter', name: 'The Sales Forge Starter', amount: 9900, credits: 100 },
  { key: 'pro', name: 'The Sales Forge Pro', amount: 24900, credits: 300 },
  { key: 'scale', name: 'The Sales Forge Scale', amount: 59900, credits: 1000 }
];

function vercelEnv(name, value, sensitive = false) {
  for (const target of ['production', 'preview', 'development']) {
    const args = ['env', 'add', name, target, '--value', value, '--force'];
    if (sensitive && target !== 'development') args.push('--sensitive');
    const result = spawnSync('vercel', args, { stdio: 'pipe', encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Could not set ${name}`);
  }
}

if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is missing. Pull the Vercel environment first.');

const existingProducts = await stripe.products.list({ active: true, limit: 100 });
for (const plan of plans) {
  let product = existingProducts.data.find(item => item.metadata?.app === 'the-sales-forge' && item.metadata?.plan === plan.key);
  if (!product) {
    product = await stripe.products.create({
      name: plan.name,
      description: `${plan.credits} production credits each month`,
      metadata: { app: 'the-sales-forge', plan: plan.key, credits: String(plan.credits) }
    }, { idempotencyKey: `sales-forge-product-${plan.key}-v1` });
  }
  const prices = await stripe.prices.list({ product: product.id, active: true, type: 'recurring', limit: 100 });
  let price = prices.data.find(item => item.currency === 'usd' && item.unit_amount === plan.amount && item.recurring?.interval === 'month');
  if (!price) {
    price = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: plan.amount,
      recurring: { interval: 'month' },
      nickname: `${plan.name} monthly`,
      metadata: { app: 'the-sales-forge', plan: plan.key, credits: String(plan.credits) }
    }, { idempotencyKey: `sales-forge-price-${plan.key}-monthly-v1` });
  }
  vercelEnv(`STRIPE_PRICE_${plan.key.toUpperCase()}`, price.id);
  console.log(`${plan.key}: ${price.id}`);
}

const webhookUrl = 'https://dsalesforge.online/api/webhooks/stripe';
const webhooks = await stripe.webhookEndpoints.list({ limit: 100 });
let webhook = webhooks.data.find(item => item.url === webhookUrl && item.status === 'enabled');
if (!webhook) {
  webhook = await stripe.webhookEndpoints.create({
    url: webhookUrl,
    description: 'The Sales Forge subscription and credit fulfillment',
    enabled_events: [
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.paid',
      'invoice.payment_failed'
    ]
  }, { idempotencyKey: 'sales-forge-webhook-v1' });
  vercelEnv('STRIPE_WEBHOOK_SECRET', webhook.secret, true);
  console.log('webhook: created and secret stored');
} else {
  console.log('webhook: already exists');
  if (!process.env.STRIPE_WEBHOOK_SECRET) console.warn('Existing webhook secret is not locally available; rotate it in Stripe if the Vercel environment lacks it.');
}

vercelEnv('NEXT_PUBLIC_APP_URL', 'https://dsalesforge.online');
const portalConfigs = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
let portal = portalConfigs.data.find(item => item.business_profile?.headline === 'Manage your The Sales Forge subscription');
if (!portal) portal = await stripe.billingPortal.configurations.create({
  business_profile: { headline: 'Manage your The Sales Forge subscription', privacy_policy_url: 'https://dsalesforge.online/privacy', terms_of_service_url: 'https://dsalesforge.online/terms' },
  features: {
    customer_update: { enabled: true, allowed_updates: ['email', 'address'] },
    invoice_history: { enabled: true }, payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: 'at_period_end', cancellation_reason: { enabled: true, options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'other'] } },
    subscription_update: { enabled: false }
  }
});
vercelEnv('STRIPE_PORTAL_CONFIGURATION', portal.id);
console.log('Stripe sandbox provisioning complete.');
