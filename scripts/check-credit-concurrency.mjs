import '../lib/env.mjs';
import { neon } from '@neondatabase/serverless';
import { account, updateSubscription, grantCredits, reserveCredits } from '../lib/store.mjs';

const userId = `credit_concurrency_${Date.now()}`;
const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
try {
  await account(userId, 'credit-concurrency@example.com');
  await updateSubscription(userId, { plan: 'starter', subscriptionStatus: 'active' });
  await grantCredits(userId, 100, 'check', userId, `grant:${userId}`);
  const same = await Promise.all(Array.from({ length: 10 }, () => reserveCredits(userId, 20, 'podcast', 'same-job')));
  if (!same.every(Boolean) || (await account(userId)).credits !== 80) throw new Error('Idempotent reservation failed under concurrency.');
  const distinct = await Promise.all(Array.from({ length: 10 }, (_, index) => reserveCredits(userId, 20, 'podcast', `job-${index}`)));
  if (distinct.filter(Boolean).length !== 4 || (await account(userId)).credits !== 0) throw new Error('Credit balance was overspent under concurrency.');
  console.log('credit concurrency verified');
} finally {
  await sql`DELETE FROM sales_forge_credit_ledger WHERE user_id = ${userId}`.catch(() => {});
  await sql`DELETE FROM sales_forge_accounts WHERE user_id = ${userId}`.catch(() => {});
}
