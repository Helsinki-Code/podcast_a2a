import '../lib/env.mjs';
import { writeFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';
import { del, get, head } from '@vercel/blob';
import { uid, stamp, initStore, saveExplainer, explainer } from '../lib/store.mjs';
import { explainerWorkflow } from '../workflows/explainer.mjs';
import { actionFingerprint } from '../workflows/explainer-steps.mjs';

const id = uid();
const ownerId = `explainer_workflow_check_${Date.now()}`;
const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
let final;
try {
  await initStore();
  await saveExplainer({ id, ownerId, createdAt: stamp(), status: 'draft', title: 'Example Domain Overview', url: 'https://example.com', brief: 'Explain what the Example Domain page is for, open its Learn more link, scroll through the destination, and finish after showing one new section.', authRequired: false, speechProvider: 'gateway', voice: 'alloy', captionStyle: 'editorial', captionOptions: { enabled: true, font: 'serif', size: 21, textColor: '#fff6df', backgroundColor: '#16252a', position: 'bottom', wordsPerCue: 5 } });
  await explainerWorkflow(id);
  final = await explainer(id);
  if (final.status !== 'complete') console.error(JSON.stringify({ status: final.status, error: final.error, transcript: final.transcript, actions: final.actions }, null, 2));
  if (final.status !== 'complete' || !final.video || !final.captions || !final.transcript?.length || !final.actions?.length) throw new Error(`Explainer workflow ended as ${final.status}: ${final.error || 'missing output'}`);
  const fingerprints = final.actions.map(actionFingerprint);
  if (new Set(fingerprints).size !== fingerprints.length) throw new Error(`The explainer repeated a browser action: ${fingerprints.join(', ')}`);
  if (new Set(final.transcript.map(text => text.trim().toLowerCase())).size !== final.transcript.length) throw new Error('The explainer repeated a narration scene.');
  if (!final.actions.some(action => ['click','type','scroll','select','press'].includes(action?.type))) throw new Error('The explainer completed without a visible human browser interaction.');
  const [video, captions] = await Promise.all([head(`assets/${final.video.split('/').pop()}`), head(`assets/${final.captions.split('/').pop()}`)]);
  if (video.size < 10_000 || captions.size < 20) throw new Error('Rendered explainer assets are unexpectedly small.');
  const [videoFile, captionFile] = await Promise.all([get(`assets/${final.video.split('/').pop()}`, { access: 'private' }), get(`assets/${final.captions.split('/').pop()}`, { access: 'private' })]);
  const [videoBytes, captionBytes] = await Promise.all([new Response(videoFile.stream).arrayBuffer(), new Response(captionFile.stream).arrayBuffer()]);
  await Promise.all([writeFile('/tmp/sales-forge-workflow-check.mp4', Buffer.from(videoBytes)), writeFile('/tmp/sales-forge-workflow-check.srt', Buffer.from(captionBytes))]);
  console.log(`explainer workflow verified: ${final.transcript.length} scene(s), ${video.size} byte MP4, ${captions.size} byte captions · /tmp/sales-forge-workflow-check.mp4`);
  console.log(JSON.stringify({ transcript: final.transcript, actions: final.actions }, null, 2));
} finally {
  await sql`DELETE FROM platform_explainers WHERE id = ${id}`.catch(() => {});
  const urls = [final?.video, final?.captions].filter(Boolean).map(value => `assets/${value.split('/').pop()}`);
  if (urls.length) await del(urls).catch(() => {});
}
