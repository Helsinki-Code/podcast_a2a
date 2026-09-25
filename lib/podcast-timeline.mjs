import { timedSubtitleCues } from '../public/captions.js';

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
    if (event?.type !== 'speech' || !clean(event.text) || !event.audio) continue;
    items.push({ type: 'speech', role: event.role === 'guest' ? 'guest' : 'host', text: clean(event.text), audio: event.audio, screen: browserScreen, video: pendingBrowserVideo, gap });
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
      const role = item.role.toUpperCase();
      const color = options.labelColors?.[item.role];
      const label = options.speakerLabels === false || index > 0 ? '' : color ? `<font color="${color}">${role}</font>  ` : `${role}: `;
      entries.push(`${cue++}\n${srtTime(item.start + part.start)} --> ${srtTime(item.start + part.end)}\n${label}${srtEscape(part.text)}\n`);
    });
  }
  return entries.join('\n');
}

export function podcastCaptionFilter(style = 'studio', subtitlePath = '/tmp/podcast-burn.srt') {
  const styles = {
    studio: 'FontName=DejaVu Sans,FontSize=13,Bold=1,PrimaryColour=&H00F7FAF4,OutlineColour=&H20131006,BackColour=&H20131006,BorderStyle=3,Outline=2,Shadow=0,Alignment=2,MarginL=40,MarginR=40,MarginV=14',
    minimal: 'FontName=DejaVu Sans,FontSize=13,Bold=1,PrimaryColour=&H00F7FAF4,OutlineColour=&H00131006,BackColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginL=40,MarginR=40,MarginV=14',
    bold: 'FontName=DejaVu Sans,FontSize=16,Bold=1,PrimaryColour=&H00D1DE80,OutlineColour=&H00131006,BackColour=&H40000000,BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginL=40,MarginR=40,MarginV=14'
  };
  return `subtitles=${subtitlePath}:force_style='${styles[style] || styles.studio}'`;
}
