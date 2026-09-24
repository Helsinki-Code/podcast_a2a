import '../lib/env.mjs';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-08-26.dahlia' });
const customer = await stripe.customers.create({ name: 'The Sales Forge deployment check', metadata: { temporary: 'true' } });
let session;
try {
  session = await stripe.checkout.sessions.create({
    mode: 'subscription', customer: customer.id, client_reference_id: 'deployment_check',
    line_items: [{ price: process.env.STRIPE_PRICE_STARTER, quantity: 1 }],
    success_url: 'https://dsalesforge.online/?billing=success', cancel_url: 'https://dsalesforge.online/?billing=cancelled',
    integration_identifier: 'sales_forge_checkabc', subscription_data: { metadata: { sales_forge_user_id: 'deployment_check', plan: 'starter' } }
  });
  if (!session.url || session.mode !== 'subscription') throw new Error('Stripe did not return a subscription Checkout URL.');
  console.log(`checkout verified: ${session.id}`);
} finally {
  if (session?.status === 'open') await stripe.checkout.sessions.expire(session.id).catch(() => {});
  await stripe.customers.del(customer.id).catch(() => {});
}
