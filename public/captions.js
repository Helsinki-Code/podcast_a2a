// Shared by the live stage (browser) and the MP4 renderer (server) so the burned-in
// subtitles follow the same phrase timing the listener saw during the live episode.
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

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
    const sentenceEnd = /[.!?…]["')\]]*$/.test(word) && current.length >= 2;
    const clauseEnd = /[,;:—–]["')\]]*$/.test(word) && current.length >= Math.ceil(maxWords / 2);
    if (sentenceEnd || clauseEnd) {
      chunks.push(current.join(' '));
      current = [];
    }
  }
  if (current.length) chunks.push(current.join(' '));
  return chunks;
}

// Speech time is closer to syllable count than word count, and speakers pause at punctuation.
function spokenWeight(chunk) {
  const words = chunk.split(/\s+/);
  const letters = words.reduce((sum, word) => sum + word.replace(/[^\p{L}\p{N}]/gu, '').length, 0);
  const pause = /[.!?…]["')\]]*$/.test(chunk) ? 6 : /[,;:—–]["')\]]*$/.test(chunk) ? 3 : 0;
  return letters + words.length * 2 + pause;
}

// Returns cues with start/end in seconds relative to the start of the speech audio.
export function timedSubtitleCues(text, duration, options = {}) {
  const maxWords = Math.max(3, Math.min(10, Number(options.wordsPerCue) || 7));
  const chunks = subtitleChunks(text, maxWords, Number(options.maxCharacters) || 48);
  const length = Math.max(.1, Number(duration) || 0);
  const weights = chunks.map(spokenWeight);
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  let cursor = 0;
  return chunks.map((chunk, index) => {
    const start = cursor;
    const end = index === chunks.length - 1 ? length : cursor + length * weights[index] / total;
    cursor = end;
    return { text: chunk, start, end };
  });
}

export function cueAt(cues, seconds) {
  if (!cues?.length) return null;
  return cues.find(cue => seconds < cue.end) || cues[cues.length - 1];
}
