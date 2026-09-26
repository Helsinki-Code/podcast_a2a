import { randomUUID } from 'node:crypto';

// Structured error reporting: always a JSON log line; also Sentry when SENTRY_DSN is set
// (sent with the plain envelope API, so no SDK is needed).
function sentryTarget() {
  try {
    const dsn = new URL(process.env.SENTRY_DSN || '');
    const project = dsn.pathname.replace(/^\//, '');
    return dsn.username && project ? { url: `${dsn.protocol}//${dsn.host}/api/${project}/envelope/`, key: dsn.username, dsn: dsn.toString() } : null;
  } catch { return null; }
}

export async function captureError(error, context = {}) {
  const message = String(error?.message || error);
  console.error(JSON.stringify({ level: 'error', at: new Date().toISOString(), message, ...context, stack: String(error?.stack || '').split('\n').slice(0, 6).join(' | ') }));
  const target = sentryTarget();
  if (!target) return;
  const eventId = randomUUID().replace(/-/g, '');
  const event = { event_id: eventId, timestamp: Date.now() / 1000, platform: 'node', level: 'error', environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development', exception: { values: [{ type: error?.name || 'Error', value: message }] }, tags: Object.fromEntries(Object.entries(context).filter(([, value]) => ['string', 'number'].includes(typeof value)).map(([key, value]) => [key, String(value).slice(0, 200)])) };
  const envelope = `${JSON.stringify({ event_id: eventId, dsn: target.dsn })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`;
  await fetch(target.url, { method: 'POST', headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${target.key}` }, body: envelope, signal: AbortSignal.timeout(5000) }).catch(() => {});
}
