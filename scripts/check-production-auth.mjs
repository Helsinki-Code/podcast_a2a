import '../lib/env.mjs';
import { createClerkClient } from '@clerk/backend';
import { neon } from '@neondatabase/serverless';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';

const suffix = Date.now();
const email = `sales-forge-production-auth-${suffix}@example.com`;
const password = `Forge-${suffix}-Check!`;
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY, publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY });
const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
const browser = new VercelEpisodeSandbox(`production-auth-${suffix}`, () => {});
let user;
const snapshotText = result => { try { return JSON.parse(result.stdout).data.snapshot; } catch { return result.stdout; } };
try {
  user = await clerk.users.createUser({ emailAddress: [email], password, firstName: 'Production', lastName: 'Auth Check', skipPasswordChecks: true, skipLegalChecks: true });
  const signInToken = await clerk.signInTokens.createSignInToken({ userId: user.id, expiresInSeconds: 60 });
  await browser.setViewport(1440, 1000);
  await browser.command(['open', 'https://dsalesforge.online/']);
  await browser.command(['wait', '1800']);
  const ticket = JSON.stringify(signInToken.token);
  await browser.command(['eval', `(async()=>{const attempt=await window.Clerk.client.signIn.create({strategy:'ticket',ticket:${ticket}});await window.Clerk.setActive({session:attempt.createdSessionId});return attempt.status})()`]);
  await browser.command(['wait', '3000']);
  const snapshot = snapshotText(await browser.command(['snapshot', '-i', '-c']));
  if (!/Choose a production allowance to open the workspace/i.test(snapshot) || !/Sign out/i.test(snapshot)) throw new Error(`The authenticated unpaid subscription gate did not appear.\n${snapshot.slice(0, 4000)}`);
  if (/AVAILABLE\s+\d+ credits/i.test(snapshot)) throw new Error('An unpaid account reached the paid workspace.');
  console.log('production auth verified: Clerk sign-in and unpaid subscription gate');
} finally {
  await browser.close().catch(() => {});
  if (user?.id) {
    await sql`DELETE FROM sales_forge_credit_ledger WHERE user_id = ${user.id}`.catch(() => {});
    await sql`DELETE FROM sales_forge_accounts WHERE user_id = ${user.id}`.catch(() => {});
    await clerk.users.deleteUser(user.id).catch(() => {});
  }
}
