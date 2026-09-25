export function episodePlanHasContent(plan, mode = 'turn') {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return false;
  if (mode === 'interrupt') return typeof plan.interrupt === 'boolean';
  const segments = Array.isArray(plan.segments) ? plan.segments : [];
  return segments.some(segment => segment?.type === 'speak'
    ? Boolean(String(segment.text || '').trim())
    : segment?.type === 'act' && Boolean(String(segment.tool || '').trim()));
}

const words = value => String(value || '').trim().split(/\s+/).filter(Boolean);

export function episodePlanQualityIssue(plan, options = {}) {
  if (!episodePlanHasContent(plan, options.mode)) return 'returned no usable speech or action';
  if (options.mode && options.mode !== 'turn') return '';
  const speech = (Array.isArray(plan?.segments) ? plan.segments : [])
    .filter(segment => segment?.type === 'speak')
    .map(segment => String(segment.text || '').trim())
    .filter(Boolean);
  if (options.role !== 'guest') return '';
  if (!speech.length) return 'must speak before taking an action';
  if (speech.some(text => words(text).length < 4)) return 'produced an unnaturally short guest fragment';
  const totalWords = words(speech.join(' ')).length;
  if (totalWords < 35) return `guest answer is too short (${totalWords} words; minimum 35)`;
  if (totalWords > 180) return `guest answer is too long (${totalWords} words; maximum 180)`;
  return '';
}
