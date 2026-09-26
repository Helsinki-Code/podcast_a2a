import { account, brandKit, saveBrandKit, assetOwnedBy, stamp, creditLedger, usageForOwner, usageForRun, episode, explainer, workspaceSettings, saveWorkspaceSettings } from '../lib/store.mjs';
import { primaryEmail } from '../lib/auth.mjs';
import { costs, createCheckout, createPortal, createTopUpCheckout, publicTopUps, LOW_CREDIT_THRESHOLD } from '../lib/billing.mjs';
import { modelConfiguration } from '../lib/models.mjs';
import { json, error, body } from '../lib/http.mjs';

// Routes a signed-in user can reach before paying.
export async function handleUnpaid({ req, res, url, auth }) {
  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    const email = await primaryEmail(auth.actorId);
    const owner = auth.role === 'owner';
    return json(res, 200, { userId: auth.actorId, workspaceId: auth.userId, role: auth.role, teamName: auth.teamName, email, account: owner ? await account(auth.userId, email) : await account(auth.userId), costs });
  }
  if (url.pathname === '/api/billing/checkout' && req.method === 'POST') {
    const input = await body(req, 5000);
    return json(res, 200, { url: await createCheckout(auth.userId, await primaryEmail(auth.userId), String(input.plan || '')) });
  }
  if (url.pathname === '/api/billing/portal' && req.method === 'POST') return json(res, 200, { url: await createPortal(auth.userId) });
  return false;
}

export async function handle({ req, res, url, parts, auth }) {
  if (url.pathname === '/api/settings' && req.method === 'GET') return json(res, 200, { retentionDays: 0, ...await workspaceSettings(auth.userId) });
  if (url.pathname === '/api/settings' && req.method === 'PUT') {
    const input = await body(req, 4000);
    const current = await workspaceSettings(auth.userId);
    const retentionDays = [0, 30, 60, 90, 180, 365].includes(Number(input.retentionDays)) ? Number(input.retentionDays) : Number(current.retentionDays) || 0;
    return json(res, 200, await saveWorkspaceSettings(auth.userId, { ...current, retentionDays, updatedAt: stamp() }));
  }
  if (url.pathname === '/api/credits' && req.method === 'GET') {
    const current = await account(auth.userId);
    return json(res, 200, { balance: current.credits, low: current.credits < LOW_CREDIT_THRESHOLD, threshold: LOW_CREDIT_THRESHOLD, costs, topUps: publicTopUps(), ledger: await creditLedger(auth.userId, 100) });
  }
  if (url.pathname === '/api/billing/topup' && req.method === 'POST') {
    const input = await body(req, 2000);
    return json(res, 200, { url: await createTopUpCheckout(auth.userId, await primaryEmail(auth.userId), String(input.pack || '')) });
  }
  if (url.pathname === '/api/usage' && req.method === 'GET') {
    const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 30));
    return json(res, 200, { days, ...await usageForOwner(auth.userId, new Date(Date.now() - days * 86400000).toISOString()), models: modelConfiguration() });
  }
  if (parts[0] === 'api' && ['episodes', 'explainers'].includes(parts[1]) && parts[2] && parts[3] === 'usage' && req.method === 'GET') {
    const kind = parts[1] === 'episodes' ? 'podcast' : 'explainer';
    const item = kind === 'podcast' ? await episode(parts[2]) : await explainer(parts[2]);
    if (!item || item.ownerId !== auth.userId) return error(res, 404, 'Not found');
    return json(res, 200, await usageForRun(kind, item.id));
  }
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
