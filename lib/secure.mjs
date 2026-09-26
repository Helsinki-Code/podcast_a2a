import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Encrypts third-party tokens at rest and signs short-lived OAuth state. The key comes from
// INTEGRATIONS_SECRET; integrations stay disabled until it is set.
function key(purpose) {
  const secret = process.env.INTEGRATIONS_SECRET;
  if (!secret || secret.length < 32) throw new Error('INTEGRATIONS_SECRET (32+ characters) is required for connected accounts.');
  return createHash('sha256').update(`${purpose}:${secret}`).digest();
}

export function encryptJson(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key('encrypt'), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}

export function decryptJson(token) {
  const [version, iv, tag, data] = String(token || '').split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Stored credentials are unreadable. Reconnect the account.');
  const decipher = createDecipheriv('aes-256-gcm', key('encrypt'), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8'));
}

export function signState(payload, ttlSeconds = 600) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds, nonce: randomBytes(8).toString('hex') })).toString('base64url');
  return `${body}.${createHmac('sha256', key('state')).update(body).digest('base64url')}`;
}

export function verifyState(state) {
  const [body, signature] = String(state || '').split('.');
  if (!body || !signature) return null;
  const expected = createHmac('sha256', key('state')).update(body).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return payload.exp >= Math.floor(Date.now() / 1000) ? payload : null;
}

export const integrationsConfigured = () => Boolean(process.env.INTEGRATIONS_SECRET && process.env.INTEGRATIONS_SECRET.length >= 32);
