import { modelFor } from './models.mjs';
import { recordUsage } from './usage.mjs';
import { buildIndex, keywordScores } from './rag.mjs';

// Kept apart from rag.mjs so workflow code can import keyword retrieval without Node-only modules.
export const EMBEDDING_DIMENSIONS = 256;
const MAX_EMBEDDED_CHUNKS = 600;

// --- Semantic retrieval ---------------------------------------------------------------------
// Chunks carry a small embedding vector when an embedding model is available. Retrieval blends
// cosine similarity with the keyword score, so it still works (keyword-only) without embeddings.
let embedder = null;
export function setEmbedder(fn) { embedder = fn; }

async function defaultEmbedder(texts) {
  if (!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL)) return null;
  const { embedMany } = await import('ai');
  const { gateway } = await import('@ai-sdk/gateway');
  const model = modelFor('embedding');
  const { embeddings, usage } = await embedMany({
    model: gateway.embeddingModel(model),
    values: texts,
    providerOptions: { openai: { dimensions: EMBEDDING_DIMENSIONS } },
    maxParallelCalls: 4
  });
  recordUsage({ feature: 'embedding', model, inputTokens: usage?.tokens });
  return embeddings;
}

async function embed(texts) {
  if (!texts.length) return [];
  try { return (await (embedder || defaultEmbedder)(texts)) || null; }
  catch { return null; }
}

const round = vector => Array.from(vector, value => Math.round(value * 10000) / 10000);

// Adds embeddings to an index built by buildIndex. Returns the index unchanged when no model is available.
export async function embedIndex(index = []) {
  const targets = index.slice(0, MAX_EMBEDDED_CHUNKS);
  const vectors = await embed(targets.map(chunk => chunk.text));
  if (!vectors) return index;
  return index.map((chunk, i) => vectors[i] ? { ...chunk, vector: round(vectors[i]) } : chunk);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export async function retrieveHybrid(index = [], query, limit = 5) {
  if (!index.length) return [];
  const built = index[0]?.terms ? index : buildIndex(index);
  const keyword = keywordScores(built, query);
  const maxKeyword = Math.max(0, ...keyword) || 1;
  const hasVectors = built.some(chunk => Array.isArray(chunk.vector));
  const queryVector = hasVectors ? (await embed([String(query).slice(0, 4000)]))?.[0] : null;
  return built.map((chunk, i) => {
    const semantic = queryVector && chunk.vector ? Math.max(0, cosine(queryVector, chunk.vector)) : 0;
    const lexical = keyword[i] / maxKeyword;
    return { source: chunk.source, text: chunk.text, score: queryVector ? semantic * 0.7 + lexical * 0.3 : lexical };
  }).filter(chunk => chunk.score > (queryVector ? 0.2 : 0)).sort((a, b) => b.score - a.score).slice(0, limit);
}
