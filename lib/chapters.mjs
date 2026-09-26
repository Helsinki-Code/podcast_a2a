// Chapters for finished videos: stored on the item, embedded in the MP4, and formatted for YouTube.
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

export function titleFromText(text, words = 6) {
  const parts = clean(text).replace(/[“”"]/g, '').split(' ').filter(Boolean);
  const title = parts.slice(0, words).join(' ').replace(/[,.;:!?-]+$/, '');
  return parts.length > words ? `${title}…` : title;
}

// A chapter shorter than `minSeconds` is absorbed into the chapter that follows it (which takes over
// its start time), so a brief intro never hides the first real step.
export function normalizeChapters(chapters, totalDuration, minSeconds = 10) {
  const sorted = (chapters || []).filter(chapter => Number.isFinite(Number(chapter.start)) && clean(chapter.title))
    .map(chapter => ({ start: Math.max(0, Number(chapter.start)), title: clean(chapter.title).slice(0, 90) }))
    .sort((a, b) => a.start - b.start);
  const result = [];
  for (const chapter of sorted) {
    if (!result.length) { result.push({ ...chapter, start: 0 }); continue; }
    if (chapter.start - result.at(-1).start < minSeconds) { result.at(-1).title = chapter.title; continue; }
    if (totalDuration && totalDuration - chapter.start < minSeconds) continue;
    result.push(chapter);
  }
  return result;
}

const stamp = seconds => {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

// YouTube needs at least three chapters, the first at 0:00, each at least ten seconds long.
export function youtubeChapterText(chapters) {
  if ((chapters || []).length < 3) return '';
  return chapters.map(chapter => `${stamp(chapter.start)} ${chapter.title}`).join('\n');
}

export function ffmetadata(chapters, totalDuration, metadata = {}) {
  const escape = value => String(value || '').replace(/([=;#\\\n])/g, '\\$1');
  const lines = [';FFMETADATA1', ...Object.entries(metadata).filter(([, value]) => value).map(([key, value]) => `${key}=${escape(value)}`)];
  chapters.forEach((chapter, index) => {
    const end = index < chapters.length - 1 ? chapters[index + 1].start : totalDuration;
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(chapter.start * 1000)}`, `END=${Math.round(Math.max(chapter.start + 0.5, end) * 1000)}`, `title=${escape(chapter.title)}`);
  });
  return `${lines.join('\n')}\n`;
}
