import { normalizeChapters, titleFromText, youtubeChapterText } from './chapters.mjs';
import { timedSubtitleCues } from '../public/captions.js';
import { roleLabel } from '../public/cast.js';

// Pure helpers for everything a finished video ships with: timed transcript exports, YouTube
// metadata, podcast chapters, thumbnails, and the podcast RSS feed.
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const html = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// timeline: [{ speaker, text, start, duration }] in seconds of the final video.
function clock(seconds, separator = ',') {
  const ms = Math.max(0, Math.round(Number(seconds) * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms % 3600000 / 60000)).padStart(2, '0')}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')}${separator}${String(ms % 1000).padStart(3, '0')}`;
}

export function cuesFromTimeline(timeline, options = {}) {
  return (timeline || []).flatMap(part => timedSubtitleCues(part.text, part.duration, options).map((cue, index) => ({ speaker: part.speaker, first: index === 0, text: cue.text, start: part.start + cue.start, end: part.start + cue.end })));
}

export function toSrt(timeline, options = {}) {
  return cuesFromTimeline(timeline, options).map((cue, index) => `${index + 1}\n${clock(cue.start)} --> ${clock(cue.end)}\n${cue.first && cue.speaker && options.speakerLabels !== false ? `${cue.speaker}: ` : ''}${cue.text}\n`).join('\n');
}

export function toVtt(timeline, options = {}) {
  const cues = cuesFromTimeline(timeline, options).map(cue => `${clock(cue.start, '.')} --> ${clock(cue.end, '.')}\n${cue.speaker && options.speakerLabels !== false ? `<v ${cue.speaker.replace(/[<>]/g, '')}>` : ''}${cue.text.replace(/</g, '&lt;')}`);
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

// One cue per word, timed by each word's share of its phrase (useful for karaoke-style editors).
export function toWordSrt(timeline) {
  const entries = [];
  for (const cue of cuesFromTimeline(timeline)) {
    const words = cue.text.split(/\s+/).filter(Boolean);
    const weights = words.map(word => word.replace(/[^\p{L}\p{N}]/gu, '').length + 2);
    const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
    let cursor = cue.start;
    words.forEach((word, index) => {
      const end = index === words.length - 1 ? cue.end : cursor + (cue.end - cue.start) * weights[index] / total;
      entries.push(`${entries.length + 1}\n${clock(cursor)} --> ${clock(end)}\n${word}\n`);
      cursor = end;
    });
  }
  return entries.join('\n');
}

export function toTranscript(timeline, title = '') {
  const stamp = seconds => { const total = Math.floor(seconds); return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`; };
  const body = (timeline || []).map(part => `[${stamp(part.start)}] ${part.speaker ? `${part.speaker}: ` : ''}${clean(part.text)}`).join('\n\n');
  return `${title ? `${title}\n\n` : ''}${body}\n`;
}

export function exportFile(timeline, format, title = '') {
  if (format === 'vtt') return { body: toVtt(timeline), type: 'text/vtt; charset=utf-8', extension: 'vtt' };
  if (format === 'srt') return { body: toSrt(timeline), type: 'application/x-subrip; charset=utf-8', extension: 'srt' };
  if (format === 'words') return { body: toWordSrt(timeline), type: 'application/x-subrip; charset=utf-8', extension: 'words.srt' };
  if (format === 'txt') return { body: toTranscript(timeline, title), type: 'text/plain; charset=utf-8', extension: 'txt' };
  if (format === 'json') return { body: JSON.stringify({ title, timeline }, null, 2), type: 'application/json; charset=utf-8', extension: 'json' };
  return null;
}

// Podcast timeline for exports: speakers are named ("Maya (HOST)").
export function podcastExportTimeline(item, timed) {
  return (timed || []).filter(entry => entry.type === 'speech').map(entry => ({ speaker: `${item.personas?.[entry.role]?.name || roleLabel(entry.role)} (${roleLabel(entry.role)})`, role: entry.role, text: entry.text, start: Number(entry.start.toFixed(3)), duration: Number((entry.audioDuration || entry.duration).toFixed(3)) }));
}

// A podcast chapter starts at each host-side question that opens a new topic.
export function podcastChapters(timeline, totalDuration, titles = []) {
  const raw = [{ start: 0, title: titles[0] || 'Introduction' }];
  let titleIndex = 1;
  for (const part of timeline) {
    if (!['host', 'cohost'].includes(part.role)) continue;
    if (!/\?\s*$/.test(clean(part.text))) continue;
    raw.push({ start: part.start, title: titles[titleIndex++] || titleFromText(part.text.split(/(?<=[.!])\s+/).pop(), 6) });
  }
  return normalizeChapters(raw, totalDuration, 20);
}

export function metadataPrompt(kind, item, timeline) {
  const transcript = (timeline || []).map(part => `${part.speaker ? `${part.speaker}: ` : ''}${clean(part.text)}`).join('\n').slice(0, 14000);
  return [
    { role: 'system', content: `You write YouTube metadata for a ${kind === 'podcast' ? 'podcast episode' : 'product walkthrough video'}. Return JSON {"title":string,"description":string,"tags":[string],"chapterTitles":[string],"thumbnailText":string}. title: under 70 characters, specific, no clickbait or emoji. description: 2 short paragraphs on what viewers learn, no hashtags, no links. tags: 8-15 lowercase search phrases. chapterTitles: ${kind === 'podcast' ? 'a 2-5 word title for the introduction followed by one per host question in order' : 'one 2-5 word title per scene in order'}. thumbnailText: 2-5 punchy words for the thumbnail.` },
    { role: 'user', content: `${kind === 'podcast' ? `Subject: ${item.outline?.subject}` : `Video: ${item.title}\nApplication: ${item.url}`}\nTranscript:\n${transcript}` }
  ];
}

export function youtubeDescription(metadata, chapters, brand = {}) {
  const chapterText = youtubeChapterText(chapters || []);
  return [clean(metadata?.description) ? String(metadata.description).trim() : '', chapterText ? `Chapters\n${chapterText}` : '', brand?.callToAction ? String(brand.callToAction) : ''].filter(Boolean).join('\n\n').slice(0, 4900);
}

// Thumbnail markup rendered in the sandbox browser (1920x1080), then scaled to 1280x720.
export function thumbnailHtml({ frame = '', text = '', logo = '', accent = '#80ded1' } = {}) {
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:1920px;height:1080px;overflow:hidden;font-family:Arial,sans-serif;background:#0b1419}body{position:relative}.frame{position:absolute;inset:0;background:url('${frame}') center/cover;filter:saturate(1.15)}.shade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(5,10,14,.92) 0,rgba(5,10,14,.72) 45%,rgba(5,10,14,.1) 100%)}h1{position:absolute;left:90px;bottom:120px;width:1100px;margin:0;color:#fff;font-size:132px;line-height:1;font-weight:900;letter-spacing:-3px;text-shadow:0 6px 30px rgba(0,0,0,.6)}h1 span{color:${accent}}img{position:absolute;left:90px;top:80px;max-height:110px;max-width:420px}</style><div class="frame"></div><div class="shade"></div>${logo ? `<img src="${logo}">` : ''}<h1>${html(text).replace(/^(\S+)/, '<span>$1</span>')}</h1>`;
}

// --- Podcast RSS -------------------------------------------------------------------------------
const xml = value => String(value ?? '').replace(/[<>&'"]/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]);

export function podcastFeedXml({ title, description, author, link, image, items }) {
  const entries = items.map(item => `<item><title>${xml(item.title)}</title><description>${xml(item.description)}</description><guid isPermaLink="false">${xml(item.id)}</guid><pubDate>${new Date(item.date).toUTCString()}</pubDate><enclosure url="${xml(item.url)}" length="${Number(item.bytes) || 0}" type="audio/mpeg"/><itunes:duration>${Math.round(Number(item.duration) || 0)}</itunes:duration><itunes:explicit>false</itunes:explicit>${item.image ? `<itunes:image href="${xml(item.image)}"/>` : ''}</item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>${xml(title)}</title><link>${xml(link)}</link><language>en</language><description>${xml(description)}</description><itunes:author>${xml(author)}</itunes:author><itunes:explicit>false</itunes:explicit>${image ? `<itunes:image href="${xml(image)}"/>` : ''}<itunes:category text="Technology"/>${entries}</channel></rss>\n`;
}
