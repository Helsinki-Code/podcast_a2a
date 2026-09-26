import { createHash } from 'node:crypto';
import { listPersonas, persona, addPersona, updatePersona, deletePersona, putAsset, uid, stamp, recordUpload } from '../lib/store.mjs';
import { buildIndex, indexStats } from '../lib/rag.mjs';
import { embedIndex, retrieveHybrid } from '../lib/rag-semantic.mjs';
import { modelProviders, speechProviders, supportedVoice } from '../lib/providers.mjs';
import { publicFetch } from '../lib/url-security.mjs';
import { htmlToText } from '../lib/html-text.mjs';
import { PERSONA_TEMPLATES } from '../lib/persona-templates.mjs';
import { json, error, body, rawBody } from '../lib/http.mjs';

async function knowledgeIndexFor(knowledge, existing = null) {
  const signature = createHash('sha256').update(JSON.stringify(knowledge.map(file => [file.name, file.text]))).digest('hex');
  if (existing?.knowledgeSignature === signature && Array.isArray(existing.knowledgeIndex)) return { knowledgeIndex: existing.knowledgeIndex, knowledgeSignature: signature };
  return { knowledgeIndex: await embedIndex(buildIndex(knowledge)), knowledgeSignature: signature };
}
// What the browser sees: no embedding vectors or full knowledge text, just per-file stats.
export function publicPersona(item) {
  if (!item) return item;
  const { knowledgeIndex, knowledgeSignature: _signature, knowledge = [], ...rest } = item;
  const stats = indexStats(knowledgeIndex || [], knowledge);
  return { ...rest, knowledge: knowledge.map(file => ({ name: file.name, characters: String(file.text || '').length, source: file.source || '' })), knowledgeStats: stats };
}

// Existing files can be kept by name ({ name, keep: true }) so edits never resend large text.
async function cleanPersona(input, existing = null) {
  const name = String(input.name || '').trim().slice(0, 80);
  const systemPrompt = String(input.systemPrompt || '').trim().slice(0, 12000);
  if (!name || !systemPrompt) throw new Error('Persona name and system prompt are required.');
  const kept = new Map((existing?.knowledge || []).map(file => [file.name, file]));
  const knowledge = (Array.isArray(input.knowledge) ? input.knowledge : []).slice(0, 20).map(k => {
    if (k?.keep && kept.has(k.name)) return kept.get(k.name);
    return { name: String(k.name || 'notes.txt').slice(0, 100), text: String(k.text || '').slice(0, 250000), ...(k.source ? { source: String(k.source).slice(0, 1000) } : {}) };
  }).filter(file => file.text);
  let image = String(input.image || '');
  if (image.startsWith('data:')) {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(image);
    if (!match) throw new Error('Upload a PNG, JPEG, or WebP display image.');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > 3_000_000) throw new Error('Display images must be under 3 MB.');
    image = await putAsset(`persona.${match[1] === 'jpeg' ? 'jpg' : match[1]}`, bytes);
  } else if (image && !/^\/assets\/[a-zA-Z0-9._-]+$/.test(image)) throw new Error('Invalid display image path.');
  return { name, systemPrompt, knowledge, image, modelProvider: String(input.modelProvider || 'gateway'), model: String(input.model || '').slice(0, 80), speechProvider: String(input.speechProvider || (process.env.OPENAI_API_KEY ? 'openai' : 'gateway')), voice: String(input.voice || 'alloy').slice(0, 100), voiceStyle: String(input.voiceStyle || '').trim().slice(0, 300) };
}

export async function handle({ req, res, url, parts, auth, userAccount }) {
  // Small media uploads (music beds, brand logos). Returns an owner-scoped asset path.
  if (url.pathname === '/api/uploads' && req.method === 'POST') {
    const kind = String(url.searchParams.get('kind') || '');
    const name = String(url.searchParams.get('name') || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
    const rules = { music: { pattern: /\.(mp3|wav|m4a|ogg)$/i, limit: 15_000_000 }, logo: { pattern: /\.(png|jpe?g|webp|svg)$/i, limit: 2_000_000 } }[kind];
    if (!rules) return error(res, 400, 'Upload kind must be music or logo.');
    if (!rules.pattern.test(name)) return error(res, 400, kind === 'music' ? 'Upload an MP3, WAV, M4A, or OGG file.' : 'Upload a PNG, JPEG, WebP, or SVG logo.');
    const data = await rawBody(req, rules.limit);
    if (!data.length) return error(res, 400, 'The file is empty.');
    if (/\.svg$/i.test(name) && /<script|on[a-z]+\s*=|javascript:/i.test(data.toString('utf8'))) return error(res, 400, 'SVG logos cannot contain scripts.');
    const asset = await putAsset(`${kind}-${name}`, data);
    await recordUpload(auth.userId, asset, kind);
    return json(res, 201, { asset });
  }
  if (url.pathname === '/api/extract' && req.method === 'POST') {
    const filename = String(url.searchParams.get('name') || '');
    const file = await rawBody(req);
    let text;
    if (/\.pdf$/i.test(filename)) {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(file), useSystemFonts: true }).promise;
      const pages = [];
      for (let i = 1; i <= Math.min(pdf.numPages, 100); i++) {
        const page = await pdf.getPage(i); const content = await page.getTextContent();
        pages.push(content.items.map(item => item.str).join(' '));
      }
      text = pages.join('\n\n');
    } else if (/\.docx$/i.test(filename)) {
      const mammoth = await import('mammoth');
      text = (await mammoth.extractRawText({ buffer: file })).value;
    } else throw new Error('Supported files: PDF and DOCX.');
    return json(res, 200, { text: text.slice(0, 250000) });
  }
  // Add a public web page to persona knowledge.
  if (url.pathname === '/api/extract-url' && req.method === 'POST') {
    const target = String((await body(req, 4000)).url || '').trim();
    const response = await publicFetch(target, { headers: { 'User-Agent': 'SalesForgeKnowledgeBot/1.0', Accept: 'text/html,text/plain' }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) return error(res, 400, `The page returned ${response.status}.`);
    const type = response.headers.get('content-type') || '';
    if (!/text\/(html|plain)|application\/xhtml/.test(type)) return error(res, 400, 'Only HTML or plain-text pages can be added. Upload PDFs as files.');
    const raw = (await response.text()).slice(0, 3_000_000);
    const page = /html/.test(type) ? htmlToText(raw) : { title: '', text: raw };
    if (page.text.length < 200) return error(res, 400, 'That page has too little readable text (it may need JavaScript or a login).');
    const host = new URL(target).hostname;
    return json(res, 200, { name: `${(page.title || host).replace(/[^\w .,-]+/g, '').trim().slice(0, 80) || host}.web.txt`, text: page.text.slice(0, 250000), source: target });
  }
  if (url.pathname === '/api/persona-templates' && req.method === 'GET') return json(res, 200, PERSONA_TEMPLATES);
  // Short voice sample so users can hear a voice and delivery style before saving.
  if (url.pathname === '/api/voices/preview' && req.method === 'POST') {
    const input = await body(req, 4000);
    const providerName = String(input.speechProvider || 'gateway');
    const provider = speechProviders.get(providerName);
    if (!provider || provider.ready?.() === false) return error(res, 400, 'That voice provider is not configured.');
    const text = String(input.text || `Hi, I'm ${String(input.name || 'your host').slice(0, 60)}. This is how I'll sound on the show.`).slice(0, 280);
    const audio = await provider.synthesize(text, supportedVoice(providerName, String(input.voice || ''), provider.voices?.[0] || 'alloy'), { style: String(input.voiceStyle || '').slice(0, 300) });
    const chunks = [];
    for await (const chunk of Buffer.isBuffer(audio) || audio instanceof Uint8Array ? [audio] : audio) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
    res.end(bytes);
    return true;
  }
  if (url.pathname === '/api/personas' && req.method === 'GET') return json(res, 200, (await listPersonas(auth.userId)).map(publicPersona));
  if (url.pathname === '/api/personas' && req.method === 'POST') {
    const input = await cleanPersona(await body(req));
    const item = { ...input, ...await knowledgeIndexFor(input.knowledge), id: uid(), ownerId: auth.userId, createdAt: stamp() };
    await addPersona(item); return json(res, 201, publicPersona(item));
  }
  if (parts[0] === 'api' && parts[1] === 'personas' && parts[2] && req.method === 'PUT') {
    const existing = await persona(parts[2]);
    if (!existing || existing.ownerId !== auth.userId) return error(res, 404, 'Persona not found');
    const input = await cleanPersona(await body(req), existing);
    const item = await updatePersona(parts[2], { ...input, ...await knowledgeIndexFor(input.knowledge, existing) });
    return item ? json(res, 200, publicPersona(item)) : error(res, 404, 'Persona not found');
  }
  // Test chat: ask the persona something and see how it answers from its prompt and knowledge.
  if (parts[0] === 'api' && parts[1] === 'personas' && parts[2] && parts[3] === 'chat' && req.method === 'POST') {
    const existing = await persona(parts[2]);
    if (!existing || existing.ownerId !== auth.userId) return error(res, 404, 'Persona not found');
    const input = await body(req, 40_000);
    const message = String(input.message || '').trim().slice(0, 2000);
    if (!message) return error(res, 400, 'Type a question for the persona.');
    const history = (Array.isArray(input.history) ? input.history : []).slice(-10).map(turn => ({ role: turn.role === 'persona' ? 'assistant' : 'user', text: String(turn.text || '').slice(0, 2000) }));
    const notes = await retrieveHybrid(existing.knowledgeIndex || [], `${message} ${history.map(turn => turn.text).join(' ')}`).catch(() => []);
    const provider = modelProviders.get(existing.modelProvider || 'gateway');
    if (!provider) return error(res, 400, 'That model provider is not configured.');
    const result = await provider.generate([
      { role: 'system', content: `${existing.systemPrompt}\n\nYou are ${existing.name}, being tested before a podcast. Answer as you would on air, in 40-120 words. Return JSON {"reply":string,"sources":[string]} where sources lists the knowledge file names you relied on.\n\nYOUR RETRIEVED KNOWLEDGE:\n${notes.map(note => `[${note.source}] ${note.text}`).join('\n---\n') || '(none relevant)'}` },
      { role: 'user', content: `${history.map(turn => `${turn.role === 'assistant' ? existing.name : 'Tester'}: ${turn.text}`).join('\n')}\nTester: ${message}` }
    ], existing.model || undefined, { user: auth.userId, tags: ['feature:persona-test'] });
    const known = new Set((existing.knowledge || []).map(file => file.name));
    return json(res, 200, { reply: String(result?.reply || '').trim(), sources: (Array.isArray(result?.sources) ? result.sources : []).map(String).filter(source => known.has(source)), retrieved: notes.map(note => note.source) });
  }
  if (parts[0] === 'api' && parts[1] === 'personas' && parts[2] && req.method === 'DELETE') {
    const existing = await persona(parts[2]);
    if (!existing || existing.ownerId !== auth.userId) return error(res, 404, 'Persona not found');
    await deletePersona(parts[2]); return json(res, 200, { ok: true });
  }
  return false;
}
