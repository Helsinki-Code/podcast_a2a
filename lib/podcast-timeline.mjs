import { timedSubtitleCues } from '../public/captions.js';
import { CAST_ROLES, roleLabel } from './cast.mjs';

export { subtitleChunks } from '../public/captions.js';

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

export function podcastTimeline(events = [], options = {}) {
  const gap = Math.max(0, Math.min(.08, Number(options.gap) || 0));
  const items = [];
  let browserScreen = null;
  let pendingBrowserVideo = null;
  for (const event of events) {
    if (event?.type === 'tool_end' && event.tool === 'browser' && event.role !== 'system') {
      browserScreen = event.screen?.image || browserScreen;
      pendingBrowserVideo = event.screen?.video || pendingBrowserVideo;
      continue;
    }
    if (event?.type === 'interrupt') {
      const last = items.at(-1);
      if (last) last.interrupted = true;
      continue;
    }
    if (event?.type !== 'speech' || !clean(event.text) || !event.audio) continue;
    items.push({ type: 'speech', role: CAST_ROLES.includes(event.role) ? event.role : 'host', text: clean(event.text), audio: event.audio, screen: browserScreen, video: pendingBrowserVideo, gap, ...(event.sources?.length ? { sources: event.sources } : {}) });
    pendingBrowserVideo = null;
  }
  return items;
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms % 3600000 / 60000)).padStart(2, '0')}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

const srtEscape = value => String(value).replace(/</g, '‹').replace(/>/g, '›');

// Phrase-by-phrase cues timed against each speech's measured audio duration, so the
// subtitles advance with the voice instead of showing the whole answer at once.
export function podcastCaptions(timedItems, options = {}) {
  let cue = 1;
  const entries = [];
  for (const item of timedItems) {
    if (item.type !== 'speech') continue;
    const spokenDuration = Math.max(.1, item.audioDuration || item.duration || 0);
    const cues = options.wholeSpeech ? [{ text: clean(item.text), start: 0, end: spokenDuration }] : timedSubtitleCues(item.text, spokenDuration, options);
    cues.forEach((part, index) => {
      const role = roleLabel(item.role);
      const color = options.labelColors?.[item.role];
      const label = options.speakerLabels === false || index > 0 ? '' : color ? `<font color="${color}">${role}</font>  ` : `${role}: `;
      entries.push(`${cue++}\n${srtTime(item.start + part.start)} --> ${srtTime(item.start + part.end)}\n${label}${srtEscape(part.text)}\n`);
    });
  }
  return entries.join('\n');
}

// Burned-in caption style. options (all optional): font sans|serif|mono, size 12-24 (libass units at
// 288 lines, ~3.75 px each at 1080p), position bottom|center|top.
export function podcastCaptionFilter(style = 'studio', subtitlePath = '/tmp/podcast-burn.srt', options = {}) {
  const fonts = { sans: 'DejaVu Sans', serif: 'DejaVu Serif', mono: 'DejaVu Sans Mono' };
  const alignment = { bottom: 2, center: 5, top: 8 }[options.position] || 2;
  const base = { studio: { size: 13, primary: '&H00F7FAF4', outline: '&H20131006', back: '&H20131006', border: 3, outlineWidth: 2, shadow: 0 }, minimal: { size: 13, primary: '&H00F7FAF4', outline: '&H00131006', back: '&H00000000', border: 1, outlineWidth: 2, shadow: 1 }, bold: { size: 16, primary: '&H00D1DE80', outline: '&H00131006', back: '&H40000000', border: 1, outlineWidth: 3, shadow: 0 } }[style] || null;
  const look = base || { size: 13, primary: '&H00F7FAF4', outline: '&H20131006', back: '&H20131006', border: 3, outlineWidth: 2, shadow: 0 };
  const size = Math.max(10, Math.min(24, Number(options.size) || look.size));
  return `subtitles=${subtitlePath}:force_style='FontName=${fonts[options.font] || fonts.sans},FontSize=${size},Bold=1,PrimaryColour=${look.primary},OutlineColour=${look.outline},BackColour=${look.back},BorderStyle=${look.border},Outline=${look.outlineWidth},Shadow=${look.shadow},Alignment=${alignment},MarginL=40,MarginR=40,MarginV=${alignment === 5 ? 0 : 14}'`;
}
