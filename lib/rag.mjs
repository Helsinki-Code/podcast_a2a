const words = text => (String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(w => !stop.has(w));
const stop = new Set('the and for that with this from have about there their would could should into what when where which your they them then than just been were are how why who its you our but not was can all will also'.split(' '));

import { modelFor } from './models.mjs';
import { recordUsage } from './usage.mjs';

export const EMBEDDING_DIMENSIONS = 256;
const MAX_EMBEDDED_CHUNKS = 600;

export function chunkKnowledge(files = []) {
  return files.flatMap(file => {
    const text = String(file.text || '').trim();
    const chunks = [];
    for (let at = 0; at < text.length; at += 900) {
      const part = text.slice(at, at + 1150).trim();
      if (part) chunks.push({ source: file.name, text: part });
    }
    return chunks;
  });
}

export function buildIndex(files = []) {
  return chunkKnowledge(files).map(({ source, text }) => {
    const terms = {};
    for (const word of words(text)) terms[word] = (terms[word] || 0) + 1;
    return { source, text, terms };
  });
}

function keywordScores(index, query) {
  const queryWords = new Set(words(query));
  return index.map(chunk => {
    let score = 0;
    for (const term of queryWords) if (chunk.terms?.[term]) score += 1 + Math.log(1 + chunk.terms[term]);
    return score;
  });
}

export function retrieve(indexOrFiles, query, limit = 5) {
  const index = indexOrFiles?.[0]?.terms ? indexOrFiles : buildIndex(indexOrFiles);
  const scores = keywordScores(index, query);
  return index.map((chunk, i) => ({ source: chunk.source, text: chunk.text, score: scores[i] }))
    .filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

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

export function indexStats(index = [], files = []) {
  const sources = new Map(files.map(file => [file.name, { name: file.name, characters: String(file.text || '').length, chunks: 0, embedded: 0 }]));
  for (const chunk of index) {
    const entry = sources.get(chunk.source) || { name: chunk.source, characters: 0, chunks: 0, embedded: 0 };
    entry.chunks++;
    if (Array.isArray(chunk.vector)) entry.embedded++;
    sources.set(chunk.source, entry);
  }
  const list = [...sources.values()];
  return { files: list, chunks: index.length, embedded: index.filter(chunk => Array.isArray(chunk.vector)).length, semantic: index.some(chunk => Array.isArray(chunk.vector)) };
}
