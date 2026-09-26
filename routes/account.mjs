import { account, brandKit, saveBrandKit, assetOwnedBy, stamp } from '../lib/store.mjs';
import { primaryEmail } from '../lib/auth.mjs';
import { costs, createCheckout, createPortal } from '../lib/billing.mjs';
import { json, error, body } from '../lib/http.mjs';

// Routes a signed-in user can reach before paying.
export async function handleUnpaid({ req, res, url, auth }) {
  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    const email = await primaryEmail(auth.userId);
    return json(res, 200, { userId: auth.userId, email, account: await account(auth.userId, email), costs });
  }
  if (url.pathname === '/api/billing/checkout' && req.method === 'POST') {
    const input = await body(req, 5000);
    return json(res, 200, { url: await createCheckout(auth.userId, await primaryEmail(auth.userId), String(input.plan || '')) });
  }
  if (url.pathname === '/api/billing/portal' && req.method === 'POST') return json(res, 200, { url: await createPortal(auth.userId) });
  return false;
}

export async function handle({ req, res, url, auth }) {
  if (url.pathname === '/api/brand' && req.method === 'GET') return json(res, 200, await brandKit(auth.userId) || {});
  if (url.pathname === '/api/brand' && req.method === 'PUT') {
    const input = await body(req, 20_000);
    const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;
    const logo = String(input.logo || '');
    if (logo && (!/^\/assets\/[a-zA-Z0-9._-]+$/.test(logo) || !await assetOwnedBy(auth.userId, logo))) return error(res, 400, 'Upload the logo before saving the brand kit.');
    const kit = {
      name: String(input.name || '').trim().slice(0, 80), logo,
      primaryColor: color(input.primaryColor, '#101c24'), accentColor: color(input.accentColor, '#80ded1'),
      outroText: String(input.outroText || '').trim().slice(0, 120), callToAction: String(input.callToAction || '').trim().slice(0, 120),
      updatedAt: stamp()
    };
    return json(res, 200, await saveBrandKit(auth.userId, kit));
  }
  return false;
}
