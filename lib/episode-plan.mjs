export function episodePlanHasContent(plan, mode = 'turn') {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return false;
  if (mode === 'interrupt') return typeof plan.interrupt === 'boolean';
  const segments = Array.isArray(plan.segments) ? plan.segments : [];
  return segments.some(segment => segment?.type === 'speak'
    ? Boolean(String(segment.text || '').trim())
    : segment?.type === 'act' && Boolean(String(segment.tool || '').trim()));
}
