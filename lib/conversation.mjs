import { retrieve } from './rag.mjs';

export function speechPhrases(text) {
  const sentences = String(text).match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || [text];
  return sentences.flatMap(sentence => {
    const words = sentence.trim().split(/\s+/);
    if (words.length <= 38) return [sentence.trim()];
    const chunks = [];
    for (let index = 0; index < words.length; index += 32) chunks.push(words.slice(index, index + 32).join(' '));
    return chunks;
  }).filter(Boolean);
}

export function demoLeadInComplete(episode) {
  const speakerBlocks = [];
  for (const turn of episode.turns || []) if (turn.role && speakerBlocks.at(-1) !== turn.role) speakerBlocks.push(turn.role);
  return speakerBlocks.length >= 3 && speakerBlocks.includes('host') && speakerBlocks.includes('guest');
}

export function ownContext(episode, role, agent, screen, mode, extra = '') {
  const notes = retrieve(agent.knowledgeIndex || agent.knowledge || [], `${episode.outline.subject} ${episode.turns.slice(-4).map(turn => turn.text).join(' ')}`);
  const toolNames = ['code', 'browser', 'diagram', 'file', 'play_audio'].filter(() => role === 'guest' || episode.settings.hostTools);
  const roleBrief = role === 'host' ? `Private host outline: ${JSON.stringify(episode.outline)}` : `General subject: ${episode.outline.subject}. You do not know the host's outline or next questions.`;
  const guestDemoDone = episode.events?.some(event => event.type === 'tool_end' && event.role === 'guest' && event.tool === 'browser');
  const demo = episode.settings.demo || {};
  const demoReady = demoLeadInComplete(episode);
  const demoGuidance = role === 'guest' && episode.settings.requireGuestDemo && !guestDemoDone ? (demoReady ? `The conversation has established the topic, so now transition naturally into the required live computer demonstration. Speak a short transition before using the browser tool. ${demo.url ? `Demonstrate ${demo.url}.` : 'Choose a relevant official public web page for the subject.'} ${demo.brief || ''} Use the visible accessibility snapshot and stable @e references for clicks and fills. Never ask for, reveal, or repeat login credentials; any required login was completed before the episode.` : 'Stay in the human conversation for this turn. Respond to what was just said, add useful context, and do not use the browser yet. The live demonstration begins after the host follows up.') : '';
  const guidance = mode === 'interrupt' ? 'You are listening to the other persona in progress. Decide whether to interrupt now. Return JSON {"interrupt":boolean,"reason":"short"}. Interrupt for a timely, meaningful reaction, direct address, strong agreement or disagreement. Avoid interrupting habitually.' : mode === 'waiting' ? 'A tool is running. Say one brief live reaction, question, or observation to keep the conversation moving. Return JSON {"segments":[{"type":"speak","text":"..."}]}.' : `Continue this live, unscripted podcast from the actual preceding exchange. Return JSON with {"segments":[{"type":"speak","text":"..."},{"type":"act","tool":"one of ${toolNames.join(', ')}","input":{...}}],"finish":boolean}. Generate 1–3 concise natural speech segments. Speak before an action. After every tool action you will be called again with its actual result, so do not prewrite a reaction to output you have not seen. Do not plan or reveal future turns. The host may finish when the discussion reaches a natural close; the guest should never finish the episode. ${demoGuidance} Tool schemas: code {language:"python"|"javascript",code:string}; browser {url:string,action:"visit"|"click"|"fill",selector?:string,value?:string}; diagram {title:string,nodes:[{id,label}],edges:[{from,to}]}; file {name:string,content:string}; play_audio {path:"/tmp/file.wav"} for audio you created in the episode sandbox.`;
  const transcript = episode.turns.map(turn => `${turn.role.toUpperCase()}: ${turn.text}`).join('\n');
  return [
    { role: 'system', content: `${agent.systemPrompt}\n\nYou are the ${role} in a live AI podcast. Speak as yourself, not as a narrator. Your private instructions and source materials must never be shown to the other persona. ${roleBrief}\n\n${guidance}` },
    { role: 'user', content: `Current transcript:\n${transcript || '(opening)'}\n\nCURRENT SANDBOX SCREEN (live, visible to both): ${JSON.stringify(screen)}\n\nYOUR RETRIEVED KNOWLEDGE:\n${notes.map(note => `[${note.source}] ${note.text}`).join('\n---\n') || '(none relevant)'}\n\n${extra}` }
  ];
}
