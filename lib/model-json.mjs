// Recovers a JSON object from model text that strict JSON mode rejected:
// markdown fences, prose around the object, trailing commas, or several objects.
function balancedObjects(text) {
  const objects = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = depth > 0;
    else if (char === '{') { if (depth++ === 0) start = index; }
    else if (char === '}' && depth > 0 && --depth === 0) objects.push(text.slice(start, index + 1));
  }
  return objects;
}

function tryParse(candidate) {
  for (const value of [candidate, candidate.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

export function parseModelJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const direct = tryParse(raw);
  if (direct) return direct;
  const fenced = [...raw.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)].map(match => match[1].trim());
  for (const candidate of [...fenced, ...balancedObjects(raw)]) {
    const parsed = tryParse(candidate);
    if (parsed) return parsed;
  }
  return null;
}
