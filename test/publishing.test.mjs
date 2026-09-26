import test from 'node:test';
import assert from 'node:assert/strict';
import { toVtt, toSrt, toWordSrt, toTranscript, podcastChapters, podcastFeedXml, youtubeDescription, exportFile } from '../lib/publishing.mjs';
import { heuristicShorts, validateShortRanges } from '../lib/shorts.mjs';

const timeline = [
  { speaker: 'Hana (HOST)', role: 'host', text: 'Welcome back. What does your team actually ship?', start: 4.5, duration: 4 },
  { speaker: 'Gus (GUEST)', role: 'guest', text: 'We ship a planning tool that keeps account teams focused on the deals that matter this week.', start: 8.5, duration: 7 },
  { speaker: 'Hana (HOST)', role: 'host', text: 'How do reps use it on Monday?', start: 30, duration: 3 },
  { speaker: 'Gus (GUEST)', role: 'guest', text: 'They open the board, sort by risk, and pick three accounts to work first.', start: 33, duration: 12 }
];

test('transcript exports: WebVTT voices, word-level cues, and a timestamped text transcript', () => {
  const vtt = toVtt(timeline);
  assert.match(vtt, /^WEBVTT\n\n00:00:04\.500 --> /);
  assert.match(vtt, /<v Hana \(HOST\)>Welcome back\./);
  assert.match(toSrt(timeline), /^1\n00:00:04,500 --> 00:00:0\d,\d{3}\nHana \(HOST\): Welcome back\./);
  const words = toWordSrt(timeline.slice(0, 1));
  assert.equal((words.match(/-->/g) || []).length, 8);
  assert.match(toTranscript(timeline, 'Ep 1'), /^Ep 1\n\n\[00:04\] Hana \(HOST\): Welcome back/);
  assert.equal(exportFile(timeline, 'nope'), null);
  assert.equal(JSON.parse(exportFile(timeline, 'json').body).timeline.length, 4);
});

test('podcast chapters start at host questions and YouTube descriptions include them', () => {
  const chapters = podcastChapters(timeline, 60, ['Intro', 'What they ship', 'Monday routine']);
  assert.deepEqual(chapters.map(chapter => chapter.title), ['What they ship', 'Monday routine']);
  const long = [...timeline, { speaker: 'Hana (HOST)', role: 'host', text: 'Last one: pricing?', start: 50, duration: 2 }];
  const three = podcastChapters(long, 80, ['Intro', 'What they ship', 'Monday routine', 'Pricing']);
  assert.equal(three.length, 3);
  assert.match(youtubeDescription({ description: 'About the tool.' }, three, { callToAction: 'Try it free' }), /About the tool\.\n\nChapters\n0:00 What they ship\n0:30 Monday routine\n0:50 Pricing\n\nTry it free/);
});

test('shorts: model ranges are validated and a heuristic fallback finds question-and-answer clips', () => {
  assert.equal(validateShortRanges(timeline, [{ startIndex: 0, endIndex: 0 }]).length, 0, 'too short');
  const valid = validateShortRanges(timeline, [{ startIndex: 2, endIndex: 3, title: 'Monday' }, { startIndex: 3, endIndex: 3 }]);
  assert.deepEqual(valid.map(clip => [clip.start, clip.end, clip.title]), [[30, 45, 'Monday']]);
  const picked = heuristicShorts(timeline);
  assert.ok(picked.length >= 1);
  assert.ok(picked.every(clip => clip.end - clip.start >= 15 && clip.end - clip.start <= 58));
});

test('RSS feed escapes content and carries enclosures', () => {
  const xml = podcastFeedXml({ title: 'Deals & Data', description: '<b>weekly</b>', author: 'Acme', link: 'https://x.test', image: '', items: [{ id: 'e1', title: 'Ep "1"', description: 'd', date: '2026-01-02T00:00:00Z', url: 'https://x.test/feeds/t/media/a.mp3', bytes: 1234, duration: 61.4 }] });
  assert.match(xml, /<title>Deals &amp; Data<\/title>/);
  assert.match(xml, /&lt;b&gt;weekly/);
  assert.match(xml, /<enclosure url="https:\/\/x\.test\/feeds\/t\/media\/a\.mp3" length="1234" type="audio\/mpeg"\/>/);
  assert.match(xml, /<itunes:duration>61<\/itunes:duration>/);
  assert.match(xml, /Ep &quot;1&quot;/);
});

test('connected-account secrets are encrypted and OAuth state is signed and expiring', async () => {
  process.env.INTEGRATIONS_SECRET = 'x'.repeat(40);
  const { encryptJson, decryptJson, signState, verifyState } = await import('../lib/secure.mjs');
  const sealed = encryptJson({ refreshToken: 'secret-token' });
  assert.doesNotMatch(sealed, /secret-token/);
  assert.deepEqual(decryptJson(sealed), { refreshToken: 'secret-token' });
  const state = signState({ userId: 'u1' });
  assert.equal(verifyState(state).userId, 'u1');
  assert.equal(verifyState(`${state}x`), null);
  assert.equal(verifyState(signState({ userId: 'u1' }, -5)), null);
  const data = sealed.split('.');
  const middle = Math.floor(data[3].length / 2);
  data[3] = data[3].slice(0, middle) + (data[3][middle] === 'A' ? 'B' : 'A') + data[3].slice(middle + 1);
  assert.throws(() => decryptJson(data.join('.')), 'a tampered ciphertext is rejected');
});
