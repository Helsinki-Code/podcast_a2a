import { persona, listEpisodes, listExplainers, creditLedger, usageForOwner, uid } from '../lib/store.mjs';
import { modelProviders } from '../lib/providers.mjs';
import { modelFor } from '../lib/models.mjs';
import { enterUsage } from '../lib/usage.mjs';
import { assertPublicHttpUrl } from '../lib/url-security.mjs';
import { json, error, body } from '../lib/http.mjs';

// Helpers behind the creation screens and the dashboard.
const monthStart = () => { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(); };

export async function handle({ req, res, url, auth }) {
  // Suggests a host angle and discussion points for a subject and cast.
  if (url.pathname === '/api/suggest-outline' && req.method === 'POST') {
    const input = await body(req, 8000);
    const subject = String(input.subject || '').trim().slice(0, 200);
    if (subject.length < 3) return error(res, 400, 'Enter a subject first.');
    const [host, guest] = await Promise.all([persona(String(input.hostId || '')), persona(String(input.guestId || ''))]);
    const describe = entry => entry && entry.ownerId === auth.userId ? `${entry.name}: ${String(entry.systemPrompt).slice(0, 600)}` : 'not chosen yet';
    const provider = modelProviders.get('gateway');
    if (!provider?.ready?.()) return error(res, 409, 'Suggestions need the AI Gateway to be configured.');
    enterUsage({ ownerId: auth.userId, kind: 'assist', id: 'outline' });
    const result = await provider.generate([
      { role: 'system', content: 'You help a podcast host prepare. Return JSON {"angle":string,"points":[string]}. angle: one sentence on the specific take for this episode. points: 4-6 short discussion points or questions, ordered to build a story, concrete and non-generic.' },
      { role: 'user', content: `Subject: ${subject}\nHost: ${describe(host)}\nGuest: ${describe(guest)}${input.demoBrief ? `\nThe guest will also demonstrate: ${String(input.demoBrief).slice(0, 500)}` : ''}` }
    ], modelFor('metadata'), { user: auth.userId, tags: ['feature:outline-suggest'] });
    return json(res, 200, { angle: String(result?.angle || '').trim().slice(0, 500), points: (Array.isArray(result?.points) ? result.points : []).map(point => String(point).trim()).filter(Boolean).slice(0, 8) });
  }
  // Tries the sign-in in a throwaway browser so selector problems show up before recording.
  if (url.pathname === '/api/login-test' && req.method === 'POST') {
    const input = await body(req, 12_000);
    const demo = { url: String(input.url || '').trim(), loginUrl: String(input.loginUrl || '').trim(), usernameSelector: String(input.usernameSelector || '').slice(0, 600), passwordSelector: String(input.passwordSelector || '').slice(0, 400), submitSelector: String(input.submitSelector || '').slice(0, 400), authRequired: true };
    try { await assertPublicHttpUrl(demo.url); if (demo.loginUrl) await assertPublicHttpUrl(demo.loginUrl); }
    catch (cause) { return error(res, 400, cause.message); }
    const credentials = { username: String(input.username || '').slice(0, 500), password: String(input.password || '').slice(0, 2000) };
    if (!credentials.username || !credentials.password) return error(res, 400, 'Enter the username and password to test.');
    const { VercelEpisodeSandbox } = await import('../lib/vercel-sandbox.mjs');
    const sandbox = new VercelEpisodeSandbox(`logintest-${uid()}`, () => {});
    try {
      const screen = await sandbox.login(demo, credentials);
      return json(res, 200, { ok: true, title: screen.title, image: screen.image });
    } catch (cause) {
      return json(res, 200, { ok: false, error: String(cause.message || cause).slice(0, 600) });
    } finally { await sandbox.close().catch(() => {}); }
  }
  // Dashboard numbers for the current month.
  if (url.pathname === '/api/stats' && req.method === 'GET') {
    const since = monthStart();
    const [episodes, explainers, ledger, usage] = await Promise.all([listEpisodes(auth.userId), listExplainers(auth.userId), creditLedger(auth.userId, 1000), usageForOwner(auth.userId, since)]);
    const thisMonth = item => String(item.createdAt || '') >= since;
    const runs = [...episodes.filter(item => item.status !== 'draft'), ...explainers.filter(item => !['draft', 'awaiting_approval', 'planning'].includes(item.status))].filter(thisMonth);
    const finished = runs.filter(item => item.status === 'complete' || item.status === 'stopped').length;
    const failed = runs.filter(item => item.status === 'failed').length;
    const spent = ledger.filter(row => String(row.createdAt) >= since).reduce((sum, row) => sum + (row.amount < 0 ? -row.amount : 0) - (String(row.kind).startsWith('refund:') ? row.amount : 0), 0);
    return json(res, 200, { since, creditsUsed: Math.max(0, spent), videosMade: episodes.filter(item => item.mp4).length + explainers.filter(item => item.video).length, runsThisMonth: runs.length, finishedThisMonth: finished, failedThisMonth: failed, successRate: finished + failed ? Math.round(finished / (finished + failed) * 100) : null, estimatedCostUsd: usage.total.costUsd });
  }
  return false;
}
