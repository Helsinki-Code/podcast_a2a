// Test double for lib/auth.mjs: "Authorization: Bearer <userId>" signs in as that user.
export async function authenticate(req) {
  const header = String(req.headers.authorization || '');
  const cookie = /(?:^|;\s*)harness_user=([^;]+)/.exec(String(req.headers.cookie || ''))?.[1];
  const userId = header.startsWith('Bearer ') ? header.slice(7) : cookie;
  return userId ? { userId, sessionId: `session-${userId}` } : null;
}
export async function primaryEmail(userId) { return `${userId}@example.com`; }
