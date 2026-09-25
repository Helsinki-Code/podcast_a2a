import './env.mjs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const root = path.resolve(process.env.DATA_DIR || 'data');
export const assets = path.join(root, 'assets');
const dbFile = path.join(root, 'studio.json');
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const remoteAssets = Boolean(process.env.VERCEL || process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
let db = { personas: [], episodes: [], accounts: [], explainers: [], creditLedger: [], webhookEvents: [] };
let saveChain = Promise.resolve();
let sqlPromise;

async function database() {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for persistent studio data.');
  sqlPromise ||= (async () => {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(databaseUrl);
    await sql`CREATE TABLE IF NOT EXISTS podcast_personas (id text PRIMARY KEY, document jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS podcast_episodes (id text PRIMARY KEY, document jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS sales_forge_accounts (user_id text PRIMARY KEY, email text, stripe_customer_id text UNIQUE, stripe_subscription_id text UNIQUE, stripe_price_id text, plan text NOT NULL DEFAULT 'none', subscription_status text NOT NULL DEFAULT 'none', credits integer NOT NULL DEFAULT 0, period_end timestamptz, updated_at timestamptz NOT NULL DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS sales_forge_credit_ledger (id text PRIMARY KEY, user_id text NOT NULL, amount integer NOT NULL, kind text NOT NULL, reference_id text, idempotency_key text UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS platform_explainers (id text PRIMARY KEY, owner_id text NOT NULL, document jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS stripe_webhook_events (id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())`;
    return sql;
  })();
  return sqlPromise;
}

export async function initStore() {
  if (databaseUrl) { await database(); return; }
  if (process.env.VERCEL) throw new Error('Connect a Postgres database and set DATABASE_URL for this Vercel deployment.');
  await mkdir(assets, { recursive: true });
  try { db = JSON.parse(await readFile(dbFile, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  db.accounts ||= []; db.explainers ||= []; db.creditLedger ||= []; db.webhookEvents ||= [];
  for (const episode of db.episodes) {
    if (episode.status === 'running' || episode.status === 'preparing') {
      episode.status = 'interrupted';
      episode.error = 'The server stopped during this episode.';
    }
  }
  await save();
}

export async function listPersonas(ownerId) {
  if (!databaseUrl) return ownerId ? db.personas.filter(item => item.ownerId === ownerId) : db.personas;
  const sql = await database();
  if (ownerId) return (await sql`SELECT document FROM podcast_personas WHERE document->>'ownerId' = ${ownerId} ORDER BY updated_at DESC`).map(row => row.document);
  return (await sql`SELECT document FROM podcast_personas ORDER BY updated_at DESC`).map(row => row.document);
}
export async function listEpisodes(ownerId) {
  if (!databaseUrl) return ownerId ? db.episodes.filter(item => item.ownerId === ownerId) : db.episodes;
  const sql = await database();
  if (ownerId) return (await sql`SELECT document FROM podcast_episodes WHERE document->>'ownerId' = ${ownerId} ORDER BY updated_at DESC`).map(row => row.document);
  return (await sql`SELECT document FROM podcast_episodes ORDER BY updated_at DESC`).map(row => row.document);
}
export async function persona(id) {
  if (!databaseUrl) return db.personas.find(item => item.id === id);
  const sql = await database();
  return (await sql`SELECT document FROM podcast_personas WHERE id = ${id}`)[0]?.document;
}
export async function episode(id) {
  if (!databaseUrl) return db.episodes.find(item => item.id === id);
  const sql = await database();
  return (await sql`SELECT document FROM podcast_episodes WHERE id = ${id}`)[0]?.document;
}
export function uid() { return randomUUID(); }
export function stamp() { return new Date().toISOString(); }

export async function copyEpisodeForRestart(item) {
  const restarted = structuredClone(item);
  Object.assign(restarted, { id: uid(), createdAt: stamp(), status: 'draft', turns: [], events: [], stopRequested: false, demoPrepared: false });
  for (const field of ['startedAt','endedAt','error','video','mp4','workflowRunId','creditsCharged']) delete restarted[field];
  return addEpisode(restarted);
}

export async function copyExplainerForRestart(item) {
  const restarted = structuredClone(item);
  Object.assign(restarted, { id: uid(), createdAt: stamp(), status: 'draft', progress: 'Ready to restart', browserPrepared: false });
  for (const field of ['startedAt','endedAt','error','video','captions','transcript','workflowRunId','creditsCharged']) delete restarted[field];
  return saveExplainer(restarted);
}

export async function account(userId, email = '') {
  if (!databaseUrl) {
    let item = db.accounts.find(row => row.userId === userId);
    if (!item) { item = { userId, email, plan: 'none', subscriptionStatus: 'none', credits: 0 }; db.accounts.push(item); await save(); }
    else if (email && item.email !== email) { item.email = email; await save(); }
    return structuredClone(item);
  }
  const sql = await database();
  const rows = await sql`INSERT INTO sales_forge_accounts (user_id, email) VALUES (${userId}, ${email || null}) ON CONFLICT (user_id) DO UPDATE SET email = COALESCE(EXCLUDED.email, sales_forge_accounts.email), updated_at = now() RETURNING user_id, email, stripe_customer_id, stripe_subscription_id, stripe_price_id, plan, subscription_status, credits, period_end`;
  return accountRow(rows[0]);
}

function accountRow(row) {
  if (!row) return null;
  return { userId: row.user_id, email: row.email, stripeCustomerId: row.stripe_customer_id, stripeSubscriptionId: row.stripe_subscription_id, stripePriceId: row.stripe_price_id, plan: row.plan, subscriptionStatus: row.subscription_status, credits: Number(row.credits || 0), periodEnd: row.period_end };
}

export async function accountByCustomer(customerId) {
  if (!databaseUrl) return structuredClone(db.accounts.find(row => row.stripeCustomerId === customerId) || null);
  const sql = await database();
  return accountRow((await sql`SELECT * FROM sales_forge_accounts WHERE stripe_customer_id = ${customerId}`)[0]);
}

export async function setStripeCustomer(userId, customerId) {
  if (!databaseUrl) { const item = await account(userId); Object.assign(db.accounts.find(row => row.userId === userId), { stripeCustomerId: customerId }); await save(); return item; }
  const sql = await database();
  await sql`UPDATE sales_forge_accounts SET stripe_customer_id = ${customerId}, updated_at = now() WHERE user_id = ${userId}`;
}

export async function updateSubscription(userId, fields) {
  const normalized = { stripeSubscriptionId: fields.stripeSubscriptionId || null, stripePriceId: fields.stripePriceId || null, plan: fields.plan || 'none', subscriptionStatus: fields.subscriptionStatus || 'none', periodEnd: fields.periodEnd || null };
  if (!databaseUrl) { const item = db.accounts.find(row => row.userId === userId) || await account(userId); Object.assign(db.accounts.find(row => row.userId === userId), normalized); await save(); return; }
  const sql = await database();
  await sql`UPDATE sales_forge_accounts SET stripe_subscription_id = ${normalized.stripeSubscriptionId}, stripe_price_id = ${normalized.stripePriceId}, plan = ${normalized.plan}, subscription_status = ${normalized.subscriptionStatus}, period_end = ${normalized.periodEnd}, updated_at = now() WHERE user_id = ${userId}`;
}

export async function grantCredits(userId, amount, kind, referenceId, idempotencyKey) {
  if (!databaseUrl) {
    if (db.creditLedger.some(row => row.idempotencyKey === idempotencyKey)) return false;
    const item = db.accounts.find(row => row.userId === userId) || await account(userId);
    item.credits += amount; db.creditLedger.push({ id: uid(), userId, amount, kind, referenceId, idempotencyKey, createdAt: stamp() }); await save(); return true;
  }
  const sql = await database();
  const rows = await sql`WITH inserted AS (INSERT INTO sales_forge_credit_ledger (id, user_id, amount, kind, reference_id, idempotency_key) VALUES (${uid()}, ${userId}, ${amount}, ${kind}, ${referenceId || null}, ${idempotencyKey}) ON CONFLICT (idempotency_key) DO NOTHING RETURNING user_id), updated AS (UPDATE sales_forge_accounts SET credits = credits + ${amount}, updated_at = now() WHERE user_id IN (SELECT user_id FROM inserted) RETURNING user_id) SELECT user_id FROM updated`;
  return Boolean(rows.length);
}

export async function reserveCredits(userId, amount, kind, referenceId) {
  const key = `reserve:${kind}:${referenceId}`;
  if (!databaseUrl) {
    if (db.creditLedger.some(row => row.idempotencyKey === key)) return true;
    const item = db.accounts.find(row => row.userId === userId) || await account(userId);
    if (!['active', 'trialing'].includes(item.subscriptionStatus) || item.credits < amount) return false;
    item.credits -= amount; db.creditLedger.push({ id: uid(), userId, amount: -amount, kind, referenceId, idempotencyKey: key, createdAt: stamp() }); await save(); return true;
  }
  const sql = await database();
  if ((await sql`SELECT 1 FROM sales_forge_credit_ledger WHERE idempotency_key = ${key}`).length) return true;
  const rows = await sql`WITH candidate AS MATERIALIZED (SELECT user_id FROM sales_forge_accounts WHERE user_id = ${userId} AND subscription_status IN ('active','trialing') AND credits >= ${amount} AND NOT EXISTS (SELECT 1 FROM sales_forge_credit_ledger WHERE idempotency_key = ${key}) FOR UPDATE), inserted AS (INSERT INTO sales_forge_credit_ledger (id, user_id, amount, kind, reference_id, idempotency_key) SELECT ${uid()}, user_id, ${-amount}, ${kind}, ${referenceId}, ${key} FROM candidate ON CONFLICT (idempotency_key) DO NOTHING RETURNING user_id), debited AS (UPDATE sales_forge_accounts SET credits = credits - ${amount}, updated_at = now() WHERE user_id IN (SELECT user_id FROM inserted) RETURNING user_id) SELECT user_id FROM debited`;
  return Boolean(rows.length);
}

export async function refundCredits(userId, amount, kind, referenceId) {
  return grantCredits(userId, amount, `refund:${kind}`, referenceId, `refund:${kind}:${referenceId}`);
}

export async function recordWebhookEvent(id) {
  if (!databaseUrl) { if (db.webhookEvents.includes(id)) return false; db.webhookEvents.push(id); await save(); return true; }
  const sql = await database();
  return Boolean((await sql`INSERT INTO stripe_webhook_events (id) VALUES (${id}) ON CONFLICT (id) DO NOTHING RETURNING id`).length);
}

export async function listExplainers(ownerId) {
  if (!databaseUrl) return db.explainers.filter(item => item.ownerId === ownerId);
  const sql = await database();
  return (await sql`SELECT document FROM platform_explainers WHERE owner_id = ${ownerId} ORDER BY updated_at DESC`).map(row => row.document);
}
export async function explainer(id) {
  if (!databaseUrl) return db.explainers.find(item => item.id === id);
  const sql = await database();
  return (await sql`SELECT document FROM platform_explainers WHERE id = ${id}`)[0]?.document;
}
export async function saveExplainer(item) {
  if (!databaseUrl) { const index = db.explainers.findIndex(row => row.id === item.id); if (index >= 0) db.explainers[index] = item; else db.explainers.unshift(item); await save(); return item; }
  const sql = await database();
  await sql`INSERT INTO platform_explainers (id, owner_id, document, updated_at) VALUES (${item.id}, ${item.ownerId}, ${JSON.stringify(item)}::jsonb, now()) ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document, updated_at = now()`;
  return item;
}
export async function setExplainerFields(id, fields) {
  const current = await explainer(id); if (!current) return null;
  Object.assign(current, fields); return saveExplainer(current);
}

export async function assetOwnedBy(ownerId, needle) {
  const value = String(needle || '');
  if (!ownerId || !value) return false;
  if (!databaseUrl) return [...db.personas, ...db.episodes, ...db.explainers].some(item => item.ownerId === ownerId && JSON.stringify(item).includes(value));
  const sql = await database();
  const pattern = `%${value.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  const rows = await sql`SELECT EXISTS (SELECT 1 FROM podcast_personas WHERE document->>'ownerId' = ${ownerId} AND document::text LIKE ${pattern} ESCAPE '\\' UNION ALL SELECT 1 FROM podcast_episodes WHERE document->>'ownerId' = ${ownerId} AND document::text LIKE ${pattern} ESCAPE '\\' UNION ALL SELECT 1 FROM platform_explainers WHERE owner_id = ${ownerId} AND document::text LIKE ${pattern} ESCAPE '\\') AS owned`;
  return Boolean(rows[0]?.owned);
}

// Pass an episode for cloud writes so concurrent episodes never overwrite one shared JSON file.
export async function save(item) {
  if (databaseUrl) {
    if (!item?.id) throw new Error('A document is required for a database save.');
    const snapshot = JSON.stringify(item);
    saveChain = saveChain.then(async () => {
      const sql = await database();
      await sql`INSERT INTO podcast_episodes (id, document, updated_at) VALUES (${item.id}, ${snapshot}::jsonb, now()) ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document, updated_at = now()`;
    });
    return saveChain;
  }
  saveChain = saveChain.then(async () => {
    const tmp = `${dbFile}.tmp`;
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, dbFile);
  });
  return saveChain;
}

export async function addPersona(item) {
  if (databaseUrl) {
    const sql = await database();
    await sql`INSERT INTO podcast_personas (id, document) VALUES (${item.id}, ${JSON.stringify(item)}::jsonb)`;
  } else { db.personas.unshift(item); await save(); }
  return item;
}
export async function updatePersona(id, item) {
  const current = await persona(id);
  if (!current) return null;
  const updated = { ...current, ...item, id };
  if (databaseUrl) {
    const sql = await database();
    await sql`UPDATE podcast_personas SET document = ${JSON.stringify(updated)}::jsonb, updated_at = now() WHERE id = ${id}`;
  } else {
    db.personas[db.personas.findIndex(p => p.id === id)] = updated;
    await save();
  }
  return updated;
}
export async function deletePersona(id) {
  if (databaseUrl) {
    const sql = await database();
    await sql`DELETE FROM podcast_personas WHERE id = ${id}`;
  } else { db.personas = db.personas.filter(p => p.id !== id); await save(); }
}
export async function addEpisode(item) {
  if (databaseUrl) await save(item);
  else { db.episodes.unshift(item); await save(); }
  return item;
}
export async function appendEpisodeEvent(id, event, turn = null) {
  if (databaseUrl) {
    const sql = await database();
    const eventJson = JSON.stringify([event]);
    const turnJson = JSON.stringify(turn ? [turn] : []);
    await sql`UPDATE podcast_episodes SET document = jsonb_set(jsonb_set(document, '{events}', COALESCE(document->'events', '[]'::jsonb) || ${eventJson}::jsonb), '{turns}', COALESCE(document->'turns', '[]'::jsonb) || ${turnJson}::jsonb), updated_at = now() WHERE id = ${id}`;
    return;
  }
  const item = await episode(id);
  item.events.push(event);
  if (turn) item.turns.push(turn);
  await save();
}
export async function setEpisodeFields(id, fields) {
  if (databaseUrl) {
    const sql = await database();
    await sql`UPDATE podcast_episodes SET document = document || ${JSON.stringify(fields)}::jsonb, updated_at = now() WHERE id = ${id}`;
    return;
  }
  Object.assign(await episode(id), fields);
  await save();
}
export async function acknowledgeEpisodeSpeech(id, eventId) {
  const acknowledgedAt = stamp();
  if (databaseUrl) {
    const sql = await database();
    await sql`UPDATE podcast_episodes SET document = jsonb_set(document, '{events}', (SELECT jsonb_agg(CASE WHEN value->>'id' = ${eventId} AND value->>'type' = 'speech' THEN value || jsonb_build_object('acknowledged', true, 'acknowledgedAt', ${acknowledgedAt}::text) ELSE value END ORDER BY ordinality) FROM jsonb_array_elements(document->'events') WITH ORDINALITY AS entries(value, ordinality))), updated_at = now() WHERE id = ${id}`;
    return;
  }
  const item = await episode(id);
  const event = item?.events.find(event => event.id === eventId && event.type === 'speech');
  if (event) { event.acknowledged = true; event.acknowledgedAt = acknowledgedAt; await save(); }
}
export async function putAsset(name, data) {
  const filename = `${uid()}-${String(name).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  return putNamedAsset(filename, data);
}
export async function putNamedAsset(filename, data) {
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) throw new Error('Invalid asset name.');
  if (remoteAssets) {
    const { put } = await import('@vercel/blob');
    await put(`assets/${filename}`, data, { access: 'private', addRandomSuffix: false });
  } else {
    await mkdir(assets, { recursive: true });
    await writeFile(path.join(assets, filename), data);
  }
  return `/assets/${filename}`;
}
export function usesRemoteAssets() { return remoteAssets; }
