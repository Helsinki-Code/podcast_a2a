import { hitRateLimit } from './store.mjs';

// Per-user limits on the endpoints that start paid work or call models, so a stuck client or a
// leaked token cannot run up costs. Limits are per hour; override with RATE_LIMITS_JSON.
const RULES = [
  { name: 'jobs', limit: 40, test: (method, path) => method === 'POST' && /^\/api\/(episodes|explainers)\/[^/]+\/(start|resume|restart|render|plan|rerender|shorts|translate|dub|youtube)$/.test(path) },
  { name: 'ai-tools', limit: 60, test: (method, path) => method === 'POST' && (/^\/api\/personas\/[^/]+\/chat$/.test(path) || path === '/api/voices/preview') },
  { name: 'ingest', limit: 30, test: (method, path) => method === 'POST' && ['/api/extract', '/api/extract-url'].includes(path) },
  { name: 'uploads', limit: 60, test: (method, path) => method === 'POST' && path === '/api/uploads' },
  { name: 'billing', limit: 20, test: (method, path) => method === 'POST' && path.startsWith('/api/billing/') },
  { name: 'writes', limit: 600, test: method => !['GET', 'HEAD', 'OPTIONS'].includes(method) }
];

function limits() {
  try { return JSON.parse(process.env.RATE_LIMITS_JSON || '{}'); } catch { return {}; }
}

// Returns null when allowed, or { rule, retryAfter } when the caller must wait.
export async function checkRateLimit(userId, method, path) {
  const rule = RULES.find(entry => entry.test(method, path));
  if (!rule || !userId) return null;
  const limit = Number(limits()[rule.name] ?? rule.limit);
  const { count, resetAt } = await hitRateLimit(`${userId}:${rule.name}`, 3600);
  return count > limit ? { rule: rule.name, limit, retryAfter: Math.max(1, resetAt - Math.floor(Date.now() / 1000)) } : null;
}
