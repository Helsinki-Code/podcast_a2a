import { createHash } from 'node:crypto';
import { listPersonas, persona, addPersona, updatePersona, deletePersona, putAsset, uid, stamp, recordUpload } from '../lib/store.mjs';
import { buildIndex, embedIndex } from '../lib/rag.mjs';
import { json, error, body, rawBody } from '../lib/http.mjs';

async function knowledgeIndexFor(knowledge, existing = null) {
  const signature = createHash('sha256').update(JSON.stringify(knowledge.map(file => [file.name, file.text]))).digest('hex');
  if (existing?.knowledgeSignature === signature && Array.isArray(existing.knowledgeIndex)) return { knowledgeIndex: existing.knowledgeIndex, knowledgeSignature: signature };
  return { knowledgeIndex: await embedIndex(buildIndex(knowledge)), knowledgeSignature: signature };
}
async function cleanPersona(input) {
  const name = String(input.name || '').trim().slice(0, 80);
  const systemPrompt = String(input.systemPrompt || '').trim().slice(0, 12000);
  if (!name || !systemPrompt) throw new Error('Persona name and system prompt are required.');
  const knowledge = (Array.isArray(input.knowledge) ? input.knowledge : []).slice(0, 20).map(k => ({ name: String(k.name || 'notes.txt').slice(0, 100), text: String(k.text || '').slice(0, 250000) }));
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
  if (url.pathname === '/api/personas' && req.method === 'GET') return json(res, 200, await listPersonas(auth.userId));
  if (url.pathname === '/api/personas' && req.method === 'POST') {
    const input = await cleanPersona(await body(req));
    const item = { ...input, ...await knowledgeIndexFor(input.knowledge), id: uid(), ownerId: auth.userId, createdAt: stamp() };
    await addPersona(item); return json(res, 201, item);
  }
  if (parts[0] === 'api' && parts[1] === 'personas' && parts[2] && req.method === 'PUT') {
    const existing = await persona(parts[2]);
    if (!existing || existing.ownerId !== auth.userId) return error(res, 404, 'Persona not found');
    const input = await cleanPersona(await body(req));
    const item = await updatePersona(parts[2], { ...input, ...await knowledgeIndexFor(input.knowledge, existing) });
    return item ? json(res, 200, item) : error(res, 404, 'Persona not found');
  }
  if (parts[0] === 'api' && parts[1] === 'personas' && parts[2] && req.method === 'DELETE') {
    const existing = await persona(parts[2]);
    if (!existing || existing.ownerId !== auth.userId) return error(res, 404, 'Persona not found');
    await deletePersona(parts[2]); return json(res, 200, { ok: true });
  }
  return false;
}
