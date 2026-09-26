// Picks self-contained highlight clips for vertical shorts from a timed transcript.
// timeline: [{ speaker, role?, text, start, duration }].
export const SHORT_MIN_SECONDS = 15;
export const SHORT_MAX_SECONDS = 58;

const words = text => String(text || '').split(/\s+/).filter(Boolean).length;

// Validates model-proposed ranges ({ startIndex, endIndex, title }) against the timeline.
export function validateShortRanges(timeline, ranges = [], limit = 3) {
  const accepted = [];
  for (const range of ranges) {
    const start = Math.max(0, Math.floor(Number(range?.startIndex)));
    const end = Math.min(timeline.length - 1, Math.floor(Number(range?.endIndex)));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const from = timeline[start].start;
    const to = timeline[end].start + timeline[end].duration;
    if (to - from < SHORT_MIN_SECONDS || to - from > SHORT_MAX_SECONDS) continue;
    if (accepted.some(other => from < other.end && to > other.start)) continue;
    accepted.push({ title: String(range.title || '').trim().slice(0, 60) || String(timeline[start].text).split(/[.!?]/)[0].slice(0, 60), start: from, end: to, startIndex: start, endIndex: end });
    if (accepted.length >= limit) break;
  }
  return accepted;
}

// Fallback when no model is available: a question followed by its answer(s), densest first.
export function heuristicShorts(timeline, limit = 3) {
  const candidates = [];
  for (let start = 0; start < timeline.length; start++) {
    let end = start;
    while (end + 1 < timeline.length && timeline[end + 1].start + timeline[end + 1].duration - timeline[start].start <= SHORT_MAX_SECONDS) end++;
    const length = timeline[end].start + timeline[end].duration - timeline[start].start;
    if (length < SHORT_MIN_SECONDS) continue;
    const text = timeline.slice(start, end + 1).map(part => part.text).join(' ');
    const opensWithQuestion = /\?\s*$/.test(String(timeline[start].text).trim()) ? 1.4 : 1;
    candidates.push({ startIndex: start, endIndex: end, score: words(text) / length * opensWithQuestion, title: String(timeline[start].text).split(/[.!?]/)[0].slice(0, 60) });
  }
  candidates.sort((a, b) => b.score - a.score);
  return validateShortRanges(timeline, candidates, limit);
}

export function shortsPrompt(timeline, title) {
  return [
    { role: 'system', content: `You pick highlight clips for vertical social video (YouTube Shorts, Reels, TikTok). Return JSON {"clips":[{"startIndex":number,"endIndex":number,"title":string}]}. Choose up to 3 non-overlapping ranges of consecutive lines that make sense on their own, open with a hook, and last ${SHORT_MIN_SECONDS}-${SHORT_MAX_SECONDS} seconds (use the start and duration values). title: a 3-8 word hook.` },
    { role: 'user', content: `Video: ${title}\nLines:\n${timeline.map((part, index) => `${index}. [${part.start.toFixed(1)}s +${part.duration.toFixed(1)}s] ${part.speaker ? `${part.speaker}: ` : ''}${part.text}`).join('\n').slice(0, 16000)}` }
  ];
}

// Vertical 1080x1920: blurred fill, the 16:9 programme centered, and a title band on top.
export function verticalFilter() {
  return '[0:v]split=2[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2,eq=brightness=-0.08[bg];[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[base];[1:v]crop=1920:640:0:0,scale=1080:-2[title];[base][title]overlay=0:150,format=yuv420p[v]';
}

export function shortTitleHtml(title, accent = '#80ded1') {
  const escape = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:1920px;height:1080px;background:#0b1419;font-family:Arial,sans-serif}div{box-sizing:border-box;width:1920px;height:640px;display:flex;align-items:center;justify-content:center;padding:0 110px;text-align:center;color:#fff;font-size:118px;line-height:1.08;font-weight:900;border-bottom:18px solid ${accent}}</style><div>${escape(title)}</div>`;
}
