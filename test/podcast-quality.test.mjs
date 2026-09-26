import test from 'node:test';
import assert from 'node:assert/strict';
import { nextSpeaker, castRoles, roleAccent } from '../lib/cast.mjs';
import { episodePhase, interjectionTrigger, ownContext, transcriptForPrompt } from '../lib/conversation.mjs';
import { interruptionAllowed } from '../lib/conversation-loop.mjs';
import { buildIndex, embedIndex, retrieveHybrid, setEmbedder, indexStats } from '../lib/rag.mjs';
import { finalAudioGraph, stageHtml, titleCardHtml, interruptionFadeFilter } from '../lib/podcast-media.mjs';
import { podcastTimeline, podcastCaptions } from '../lib/podcast-timeline.mjs';

const panel = { personas: { host: { name: 'Hana Ito' }, cohost: { name: 'Cole' }, guest: { name: 'Gus' }, guest2: { name: 'Gia' } }, turns: [], settings: {}, outline: { subject: 'Sales' } };

test('panel turn order: host hands the floor to the addressed guest, co-host alternates follow-ups', () => {
  assert.deepEqual(castRoles(panel), ['host', 'cohost', 'guest', 'guest2']);
  assert.equal(nextSpeaker(panel, 'host', { segments: [{ type: 'speak', text: 'Gia, how do you see it?' }] }), 'guest2');
  assert.equal(nextSpeaker(panel, 'host', { next: 'guest', segments: [] }), 'guest');
  const afterHost = { ...panel, turns: [{ role: 'host', text: 'q' }, { role: 'guest', text: 'a' }] };
  assert.equal(nextSpeaker(afterHost, 'guest'), 'cohost');
  const afterCohost = { ...panel, turns: [{ role: 'host', text: 'q' }, { role: 'guest', text: 'a' }, { role: 'cohost', text: 'q2' }, { role: 'guest2', text: 'a2' }] };
  assert.equal(nextSpeaker(afterCohost, 'guest2'), 'host');
  assert.equal(nextSpeaker({ personas: { host: {}, guest: {} }, turns: [] }, 'guest'), 'host');
  assert.equal(roleAccent({ accent: '#123456' }, 'host'), '#123456');
});

test('episode arc: opening, closing near the target, and a forced close past it', () => {
  const words = count => Array.from({ length: count }, () => 'word').join(' ');
  const base = { settings: { targetMinutes: 2 }, turns: [] };
  assert.equal(episodePhase(base), 'opening');
  assert.equal(episodePhase({ ...base, turns: [{ role: 'host', text: words(100) }] }), 'body');
  assert.equal(episodePhase({ ...base, turns: [{ role: 'host', text: words(260) }] }), 'closing');
  assert.equal(episodePhase({ ...base, turns: [{ role: 'host', text: words(400) }] }), 'must-close');
  const text = JSON.stringify(ownContext({ ...panel, turns: [], settings: { targetMinutes: 5 } }, 'host', { systemPrompt: 'Host.', name: 'Hana Ito' }, { type: 'idle' }, 'turn'));
  assert.match(text, /opening of the show/);
  assert.match(text, /co-host Cole/);
  assert.match(text, /set \\"next\\" to that panelist/);
});

test('long transcripts are replaced by a running summary plus recent lines', () => {
  const turns = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'guest' : 'host', text: `line ${i}` }));
  const text = transcriptForPrompt({ ...panel, turns, memory: { summary: 'They discussed pricing.', throughTurn: 9 } });
  assert.match(text, /They discussed pricing/);
  assert.doesNotMatch(text, /line 3/);
  assert.match(text, /line 11/);
});

test('interruptions need a real trigger and respect the per-episode cap and spacing', () => {
  assert.equal(interjectionTrigger('Gia, would you agree with that?', 'Gia Lopez'), 'addressed');
  assert.equal(interjectionTrigger('Honestly that is just wrong for most teams.', 'Bob'), 'strong-reaction');
  assert.equal(interjectionTrigger('The dashboard loads quickly.', 'Bob'), '');
  const item = { settings: { interjections: true, maxInterruptions: 2 }, turns: new Array(10) };
  assert.equal(interruptionAllowed(item, { count: 0, lastTurn: -1 }), true);
  assert.equal(interruptionAllowed(item, { count: 2, lastTurn: 1 }), false);
  assert.equal(interruptionAllowed(item, { count: 1, lastTurn: 9 }), false);
  assert.equal(interruptionAllowed({ settings: { interjections: false }, turns: [] }, { count: 0, lastTurn: -1 }), false);
});

test('hybrid retrieval ranks semantic matches that share no keywords', async () => {
  const vectors = { cats: [1, 0, 0], felines: [0.98, 0.1, 0], bread: [0, 0, 1] };
  setEmbedder(async texts => texts.map(text => /bread/i.test(text) ? vectors.bread : /feline/i.test(text) ? vectors.felines : vectors.cats));
  try {
    const index = await embedIndex(buildIndex([{ name: 'pets.txt', text: 'Felines are independent companions that groom themselves.' }, { name: 'baking.txt', text: 'Bread needs flour, water, salt, and time.' }]));
    assert.ok(index.every(chunk => Array.isArray(chunk.vector)));
    const results = await retrieveHybrid(index, 'Tell me about cats');
    assert.equal(results[0].source, 'pets.txt');
    assert.equal(indexStats(index, [{ name: 'pets.txt', text: 'x' }]).semantic, true);
  } finally { setEmbedder(null); }
  const keywordOnly = await retrieveHybrid(buildIndex([{ name: 'a.txt', text: 'solar panels on roofs' }]), 'solar');
  assert.equal(keywordOnly[0].source, 'a.txt');
});

test('render graphs: panel stage, title cards, ducked music bed, interruption fade', () => {
  const markup = stageHtml(panel, { role: 'guest2' }, {}, '');
  assert.equal((markup.match(/class="person/g) || []).length, 4);
  assert.match(markup, /person active[^>]*><div class="avatar"><span>G<\/span>/);
  assert.match(titleCardHtml(panel, {}, 'intro'), /NOW PLAYING/);
  assert.match(finalAudioGraph({ bed: true, volume: 0.1, bedStart: 4.5, bedDuration: 60 }), /sidechaincompress.*loudnorm=I=-16/);
  assert.match(finalAudioGraph({}), /^\[0:a\]loudnorm/);
  assert.match(interruptionFadeFilter(3), /afade=t=out:st=2\.780/);
  const timeline = podcastTimeline([{ type: 'speech', role: 'guest2', text: 'Cut', audio: 'a' }, { type: 'interrupt', by: 'host' }, { type: 'speech', role: 'host', text: 'Sorry', audio: 'b' }]);
  assert.equal(timeline[0].interrupted, true);
  assert.equal(timeline[0].role, 'guest2');
  assert.match(podcastCaptions([{ ...timeline[0], start: 0, audioDuration: 1 }]), /GUEST 2: Cut/);
});
