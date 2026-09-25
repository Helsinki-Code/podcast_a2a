const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

export function podcastTimeline(events = [], options = {}) {
  const gap = Math.max(.08, Math.min(.3, Number(options.gap) || .14));
  const items = [];
  let browserScreen = null;
  for (const event of events) {
    if (event?.type === 'tool_end' && event.tool === 'browser' && event.role !== 'system') {
      browserScreen = event.screen?.image || browserScreen;
      if (event.screen?.video) items.push({ type: 'browser', role: event.role, video: event.screen.video, image: event.screen.image || null, gap: 0 });
      continue;
    }
    if (event?.type !== 'speech' || !clean(event.text) || !event.audio) continue;
    items.push({ type: 'speech', role: event.role === 'guest' ? 'guest' : 'host', text: clean(event.text), audio: event.audio, screen: browserScreen, gap });
  }
  return items;
}

export function subtitleChunks(text, maxWords = 7, maxCharacters = 48) {
  const words = clean(text).split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = [];
  for (const word of words) {
    const candidate = [...current, word];
    if (current.length && (candidate.length > maxWords || candidate.join(' ').length > maxCharacters)) {
      chunks.push(current.join(' '));
      current = [word];
    } else current = candidate;
  }
  if (current.length) chunks.push(current.join(' '));
  return chunks;
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms % 3600000 / 60000)).padStart(2, '0')}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

export function podcastCaptions(timedItems, options = {}) {
  let cue = 1;
  const entries = [];
  for (const item of timedItems) {
    if (item.type !== 'speech') continue;
    const chunks = options.wholeSpeech ? [clean(item.text)] : subtitleChunks(item.text, Math.max(3, Math.min(10, Number(options.wordsPerCue) || 7)));
    const spokenDuration = Math.max(.1, item.audioDuration || item.duration || 0);
    const words = chunks.map(chunk => chunk.split(/\s+/).length);
    const total = words.reduce((sum, count) => sum + count, 0) || 1;
    let cursor = item.start;
    chunks.forEach((chunk, index) => {
      const end = index === chunks.length - 1 ? item.start + spokenDuration : cursor + spokenDuration * words[index] / total;
      const label = options.speakerLabels === false ? '' : `${item.role.toUpperCase()}: `;
      entries.push(`${cue++}\n${srtTime(cursor)} --> ${srtTime(end)}\n${label}${chunk}\n`);
      cursor = end;
    });
  }
  return entries.join('\n');
}
