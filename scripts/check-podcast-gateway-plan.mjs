import '../lib/env.mjs';
import { modelProviders } from '../lib/providers.mjs';
import { ownContext } from '../lib/conversation.mjs';
import { episodePlanHasContent, episodePlanQualityIssue } from '../lib/episode-plan.mjs';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';

const id = `podcast-gateway-plan-${Date.now()}`;
const browser = new VercelEpisodeSandbox(id, () => {});
try {
  await browser.command(['open', 'https://example.com']);
  const screen = await browser.capture(null, 'https://example.com');
  const capture = await browser.captureForModel('https://example.com');
  const episode = {
    ownerId: id,
    outline: { subject: 'Example Domain', angle: '', points: '' },
    turns: [
      { role: 'host', text: 'What can you see in the live browser?' },
      { role: 'guest', text: 'I will inspect the page and explain it.' },
      { role: 'host', text: 'Please show one safe visible interaction.' }
    ],
    events: [],
    settings: { hostTools: false, requireGuestDemo: true, demo: { url: 'https://example.com', brief: 'Explain the visible page and use one safe browser action.' } }
  };
  const agent = { systemPrompt: 'You are a concise guest who responds to the host and demonstrates the visible page.', knowledge: [], knowledgeIndex: [] };
  const messages = ownContext(episode, 'guest', agent, screen, 'turn');
  const result = await modelProviders.get('gateway').generateVisual(
    messages,
    capture.image,
    process.env.AI_GATEWAY_GUEST_COMPUTER_MODEL || process.env.AI_GATEWAY_COMPUTER_MODEL || 'google/gemini-3.1-flash-lite',
    { output: 'podcast', user: id, tags: ['feature:podcast-visual-contract-check'] }
  );
  if (!episodePlanHasContent(result)) throw new Error(`Visual podcast plan used the wrong shape: ${JSON.stringify(result).slice(0, 1200)}`);
  const qualityIssue = episodePlanQualityIssue(result, { role: 'guest', mode: 'turn' });
  if (qualityIssue) throw new Error(`Visual guest plan failed the answer quality gate: ${qualityIssue}`);
  const guestWords = result.segments.filter(segment => segment.type === 'speak').flatMap(segment => String(segment.text || '').split(/\s+/).filter(Boolean)).length;
  console.log(JSON.stringify({ verified: true, segmentTypes: result.segments.map(segment => segment.type), hasSpeech: result.segments.some(segment => segment.type === 'speak'), hasAction: result.segments.some(segment => segment.type === 'act'), guestWords }, null, 2));
} finally {
  await browser.close().catch(() => {});
}
