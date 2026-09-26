const words = text => (String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(w => !stop.has(w));
const stop = new Set('the and for that with this from have about there their would could should into what when where which your they them then than just been were are how why who its you our but not was can all will also'.split(' '));

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

export function keywordScores(index, query) {
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
