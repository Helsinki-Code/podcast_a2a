import './env.mjs';
import { createClerkClient } from '@clerk/backend';

let clerk;
function client() {
  if (!process.env.CLERK_SECRET_KEY) throw new Error('CLERK_SECRET_KEY is not configured.');
  clerk ||= createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY, publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY });
  return clerk;
}

export async function authenticate(req) {
  const protocol = String(req.headers['x-forwarded-proto'] || (process.env.VERCEL ? 'https' : 'http')).split(',')[0];
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0];
  const request = new Request(`${protocol}://${host}${req.url}`, { method: req.method, headers: req.headers });
  const parties = [`${protocol}://${host}`, 'https://dsalesforge.online', 'https://podcast-a2a.vercel.app'];
  if (!process.env.VERCEL) parties.push('http://127.0.0.1:3377', 'http://localhost:3377');
  const state = await client().authenticateRequest(request, process.env.VERCEL ? { authorizedParties: parties } : {});
  const auth = state.toAuth();
  if (!auth.userId) return null;
  return { userId: auth.userId, sessionId: auth.sessionId };
}

export async function primaryEmail(userId) {
  const user = await client().users.getUser(userId);
  return user.emailAddresses.find(item => item.id === user.primaryEmailAddressId)?.emailAddress || user.emailAddresses[0]?.emailAddress || '';
}
