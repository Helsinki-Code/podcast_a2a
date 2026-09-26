import { retrieve } from './rag.mjs';
import { castRoles, guestRoles, isGuestRole, isHostSide, personaName, roleLabel } from './cast.mjs';

export function speechPhrases(text) {
  const sentences = String(text).match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || [text];
  return sentences.flatMap(sentence => {
    const words = sentence.trim().split(/\s+/);
    if (words.length <= 24) return [sentence.trim()];
    const chunks = [];
    for (let index = 0; index < words.length; index += 20) chunks.push(words.slice(index, index + 20).join(' '));
    return chunks;
  }).filter(Boolean);
}

export function speechBlocks(text, maxWords = 72) {
  const blocks = [];
  let current = [];
  for (const phrase of speechPhrases(text)) {
    const phraseWords = phrase.split(/\s+/).filter(Boolean);
    if (current.length && current.length + phraseWords.length > maxWords) {
      blocks.push(current.join(' '));
      current = phraseWords;
    } else current.push(...phraseWords);
  }
  if (current.length) blocks.push(current.join(' '));
  return blocks;
}

export function guestDemoDone(episode) {
  return Boolean(episode?.guestDemoDone) || Boolean(episode?.events?.some(event => event.type === 'tool_end' && event.role === 'guest' && event.tool === 'browser'));
}

export function demoLeadInComplete(episode) {
  const speakerBlocks = [];
  for (const turn of episode.turns || []) if (turn.role && speakerBlocks.at(-1) !== turn.role) speakerBlocks.push(turn.role);
  return speakerBlocks.length >= 3 && speakerBlocks.some(isHostSide) && speakerBlocks.some(isGuestRole);
}

const WORDS_PER_MINUTE = 150;
export const spokenMinutes = turns => (turns || []).reduce((sum, turn) => sum + String(turn.text || '').split(/\s+/).filter(Boolean).length, 0) / WORDS_PER_MINUTE;

// Where the episode is in its arc, from the spoken length so far and the target length.
export function episodePhase(episode) {
  const turns = episode?.turns || [];
  if (!turns.length) return 'opening';
  const target = Number(episode?.settings?.targetMinutes) || 0;
  if (!target) return 'body';
  const minutes = spokenMinutes(turns);
  if (minutes >= target * 1.3) return 'must-close';
  if (minutes >= target * 0.85) return 'closing';
  return 'body';
}

// Older turns are replaced by a running summary so long episodes keep a bounded prompt.
export function transcriptForPrompt(episode) {
  const turns = episode?.turns || [];
  const memory = episode?.memory;
  const through = Math.min(turns.length, Number(memory?.throughTurn) || 0);
  const line = turn => `${roleLabel(turn.role)} (${personaName(episode, turn.role)}): ${turn.text}`;
  const recent = turns.slice(through).map(line).join('\n');
  if (!through || !memory?.summary) return recent;
  return `EARLIER IN THIS EPISODE (summary of the first ${through} lines):\n${memory.summary}\n\nMOST RECENT LINES (verbatim):\n${recent}`;
}

function castDescription(episode, role) {
  return castRoles(episode).filter(other => other !== role).map(other => `${personaName(episode, other)} (${other === 'cohost' ? 'co-host' : isGuestRole(other) ? 'guest' : 'host'}, role key "${other}")`).join(', ');
}

function structureGuidance(episode, role) {
  const phase = episodePhase(episode);
  const target = Number(episode.settings?.targetMinutes) || 0;
  const guestNames = guestRoles(episode).map(guest => personaName(episode, guest)).join(' and ');
  if (isHostSide(role)) {
    if (phase === 'opening') return `This is the opening of the show. Welcome the listeners, introduce yourself${episode.personas?.cohost && role === 'host' ? ` and your co-host ${personaName(episode, 'cohost')}` : ''}, introduce ${guestNames || 'your guest'} and today's topic in two or three sentences, then ask your first question.`;
    if (phase === 'closing') return 'The episode is near its target length. Start wrapping up: ask for a final thought or, if you already have it, summarize two or three takeaways, thank the guests by name, sign off warmly, and set finish true.';
    if (phase === 'must-close') return 'The episode has run past its target length. Close the show now in this turn: a short summary, thanks to the guests by name, a sign-off, and finish true.';
    return target ? `Aim for an episode of about ${target} minutes; keep the conversation moving through the outline.` : '';
  }
  if (phase === 'closing' || phase === 'must-close') return 'The host is wrapping up the episode. Give a short, memorable final thought in 30–60 words.';
  return '';
}

export function ownContext(episode, role, agent, screen, mode, extra = '', options = {}) {
  const notes = options.notes || retrieve(agent.knowledgeIndex || agent.knowledge || [], `${episode.outline.subject} ${episode.turns.slice(-4).map(turn => turn.text).join(' ')}`);
  const guest = isGuestRole(role);
  const toolNames = ['code', 'browser', 'diagram', 'file', 'play_audio'].filter(() => guest || episode.settings.hostTools);
  const roleBrief = isHostSide(role) ? `Private host outline: ${JSON.stringify(episode.outline)}` : `General subject: ${episode.outline.subject}. You do not know the host's outline or next questions.`;
  const demoDone = guestDemoDone(episode);
  const demo = episode.settings.demo || {};
  const demoReady = demoLeadInComplete(episode);
  const computerUse = Boolean(process.env.COMPUTER_USE_SNAPSHOT_ID);
  const browserGuidance = computerUse ? 'The current desktop image and accessibility description represent the same visible Chrome session. Use screenshot coordinates for mouse and keyboard actions.' : 'Use the visible accessibility snapshot and stable @e references for clicks and fills.';
  const demoGuidance = role === 'guest' && episode.settings.requireGuestDemo && !demoDone ? (demoReady ? `The conversation has established the topic, so now transition naturally into the required live computer demonstration. Speak a short transition before using the browser tool. ${demo.url ? `Demonstrate ${demo.url}.` : 'Choose a relevant official public web page for the subject.'} ${demo.brief || ''} ${browserGuidance} Never ask for, reveal, or repeat login credentials; any required login was completed before the episode.` : 'Stay in the human conversation for this turn. Respond to what was just said, add useful context, and do not use the browser yet. The live demonstration begins after the host follows up.') : '';
  const browserSchema = computerUse ? 'browser {action:"visit",url:string} or {action:"click"|"double_click"|"right_click"|"type",selector?:"@e2",x:number,y:number,text?:string} or {action:"scroll",direction:"up"|"down",amount:number} or {action:"key",key:string}. Include the exact visible @e selector whenever the accessibility snapshot provides one; use coordinates alone for canvas or controls without refs' : 'browser {url:string,action:"visit"|"click"|"fill",selector?:string,value?:string}';
  const latestHost = [...(episode.turns || [])].reverse().find(turn => isHostSide(turn.role))?.text || '';
  const panel = guestRoles(episode).length > 1;
  const speakingRules = guest
    ? `Give a complete, useful answer in 45–110 words and 2–5 connected sentences. Start by answering the host's latest question directly, then explain why or how with concrete product details. Never answer with a single word, a fragment, a vague acknowledgement, or an unrelated sales pitch. When a browser screen is visible, name the exact visible page or control and explain what it does before choosing the next action.${panel ? ' Other panelists may have answered before you; build on or respectfully challenge them by name instead of repeating them.' : ''} ${latestHost ? `The question you must answer is: ${JSON.stringify(latestHost)}` : ''}`
    : `Keep the ${role === 'cohost' ? 'co-host' : 'host'} turn to 15–45 words. React specifically to what was just said, then ask one focused follow-up question. Avoid generic praise and stacked questions.${panel ? ' Address one panelist by name and set "next" to that panelist\'s role key so they answer next.' : ''}`;
  const nextField = isHostSide(role) && panel ? ',"next":"guest|guest2|guest3"' : '';
  const citationRule = notes.length ? ' When you use your retrieved knowledge, credit it naturally in speech (for example "our onboarding guide says…") and list the source names you relied on in "sources".' : '';
  const guidance = mode === 'interrupt' ? 'You are listening to another persona in progress. Decide whether to interrupt now. Return JSON {"interrupt":boolean,"reason":"short"}. Interrupt only for a timely, meaningful reaction: you were addressed directly, you strongly agree or disagree, or a factual error needs correcting. Avoid interrupting habitually.' : mode === 'waiting' ? 'A tool is running. Say one brief live reaction, question, or observation to keep the conversation moving. Return JSON {"segments":[{"type":"speak","text":"..."}]}.' : `Continue this live, unscripted podcast from the actual preceding exchange. Return JSON with {"segments":[{"type":"speak","text":"..."},{"type":"act","tool":"one of ${toolNames.join(', ')}","input":{...}}],"finish":boolean,"sources":["file name"]${nextField}}. ${speakingRules} ${structureGuidance(episode, role)} Use one coherent speech segment unless a browser action must follow it. Speak before an action. After every tool action you will be called again with its actual result, so do not prewrite a reaction to output you have not seen. Do not plan or reveal future turns. The host may finish when the discussion reaches a natural close; guests and the co-host never finish the episode.${citationRule} ${demoGuidance} Tool schemas: code {language:"python"|"javascript",code:string}; ${browserSchema}; diagram {title:string,nodes:[{id,label}],edges:[{from,to}]}; file {name:string,content:string}; play_audio {path:"/tmp/file.wav"} for audio you created in the episode sandbox.`;
  const transcript = transcriptForPrompt(episode);
  const castLine = castDescription(episode, role);
  return [
    { role: 'system', content: `${agent.systemPrompt}\n\nYou are the ${role === 'cohost' ? 'co-host' : isGuestRole(role) ? 'guest' : 'host'} in a live AI podcast. Your name is ${agent.name || personaName(episode, role)}. ${castLine ? `Also on the show: ${castLine}.` : ''} Speak as yourself, not as a narrator. Your private instructions and source materials must never be shown to the other personas. ${roleBrief}\n\n${guidance}` },
    { role: 'user', content: `Current transcript:\n${transcript || '(opening)'}\n\nCURRENT SANDBOX SCREEN (live, visible to everyone): ${JSON.stringify(screen)}\n\nYOUR RETRIEVED KNOWLEDGE:\n${notes.map(note => `[${note.source}] ${note.text}`).join('\n---\n') || '(none relevant)'}\n\n${extra}` }
  ];
}

// Cheap, model-free checks for whether the listener has a reason to cut in on this phrase.
export function interjectionTrigger(phrase, listenerName = '') {
  const text = String(phrase || '').toLowerCase();
  const first = String(listenerName || '').trim().toLowerCase().split(/\s+/)[0];
  if (first && first.length > 1 && new RegExp(`\\b${first.replace(/[^a-z0-9]/g, '')}\\b`).test(text)) return 'addressed';
  if (/\b(?:wrong|disagree|not true|that's a myth|actually,|no way|i doubt|exactly right|absolutely right|hold on)\b/.test(text)) return 'strong-reaction';
  if (/\?\s*$/.test(text) && /\b(?:you|your)\b/.test(text)) return 'question';
  return '';
}
