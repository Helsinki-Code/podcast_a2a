import '../lib/env.mjs';
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
const [accounts, personas, episodes, explainers] = await Promise.all([
  sql`SELECT count(*)::int AS count FROM sales_forge_accounts WHERE email LIKE 'sales-forge-check-%@example.com'`,
  sql`SELECT count(*)::int AS count FROM podcast_personas WHERE document->>'name' IN ('E2E Host','E2E Guest')`,
  sql`SELECT count(*)::int AS count FROM podcast_episodes WHERE document->'outline'->>'subject' = 'Deployment verification'`,
  sql`SELECT count(*)::int AS count FROM platform_explainers WHERE document->>'title' = 'Deployment verification'`
]);
const counts = [accounts[0].count, personas[0].count, episodes[0].count, explainers[0].count];
if (counts.some(Boolean)) throw new Error(`E2E cleanup left records: ${counts.join(',')}`);
console.log('e2e cleanup verified');
