import '../lib/env.mjs';
import { neon } from '@neondatabase/serverless';
import { del, head } from '@vercel/blob';
import { uid, stamp, initStore, saveExplainer, explainer } from '../lib/store.mjs';
import { explainerWorkflow } from '../workflows/explainer.mjs';

const id = uid();
const ownerId = `explainer_workflow_check_${Date.now()}`;
const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
let final;
try {
  await initStore();
  await saveExplainer({ id, ownerId, createdAt: stamp(), status: 'draft', title: 'Example Domain Overview', url: 'https://example.com', brief: 'Explain what the Example Domain page is for, who should use it, and the single link available on the page. Finish after covering that one screen.', authRequired: false, speechProvider: 'gateway', voice: 'alloy' });
  await explainerWorkflow(id);
  final = await explainer(id);
  if (final.status !== 'complete' || !final.video || !final.captions || !final.transcript?.length) throw new Error(`Explainer workflow ended as ${final.status}: ${final.error || 'missing output'}`);
  const [video, captions] = await Promise.all([head(`assets/${final.video.split('/').pop()}`), head(`assets/${final.captions.split('/').pop()}`)]);
  if (video.size < 10_000 || captions.size < 20) throw new Error('Rendered explainer assets are unexpectedly small.');
  console.log(`explainer workflow verified: ${final.transcript.length} scene(s), ${video.size} byte MP4, ${captions.size} byte captions`);
} finally {
  await sql`DELETE FROM platform_explainers WHERE id = ${id}`.catch(() => {});
  const urls = [final?.video, final?.captions].filter(Boolean).map(value => `assets/${value.split('/').pop()}`);
  if (urls.length) await del(urls).catch(() => {});
}
