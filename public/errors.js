// Turns raw pipeline errors into a plain-language explanation and a next step.
// Used by the studio, the library rows, and the explainer list.
const rules = [
  [/credits?/i, 'Not enough credits', 'Top up credits or wait for your plan to renew, then try again.'],
  [/login|sign[- ]?in|password|credential|mfa|captcha/i, 'The demo platform sign-in did not finish', 'Check the username and password, or open the secure desktop to finish sign-in (MFA, CAPTCHA) yourself.'],
  [/public|private network|local address|http:\/\/ or https:\/\//i, 'That address can’t be opened', 'Use a public https:// URL. Local, intranet, and private-network addresses are blocked for safety.'],
  [/could not reach|ENOTFOUND|ECONNREFUSED|timed? ?out|net::ERR|navigation/i, 'The app couldn’t be reached', 'Check the URL opens in your own browser, then retry. If the site blocks automated browsers, try a different start page.'],
  [/serialization|recording workflow/i, 'The recording workflow stopped', 'Restart the episode. If it already recorded speech, Resume continues from the last line. Failed-run credits are refunded.'],
  [/playback|acknowledge|live player/i, 'The live player stopped responding', 'Keep this tab open while recording, or choose Background generation so the episode continues without it.'],
  [/not a JSON object|No object generated|could not parse|invalid .*plan/i, 'The AI returned an unusable reply', 'This is usually temporary. Resume or retry; the conversation so far is kept.'],
  [/voice|speech|tts/i, 'A voice line could not be generated', 'Retry in a minute. If it keeps failing, pick a different voice for the persona.'],
  [/compatible action|Invalid target|walkthrough|milestone/i, 'The browser agent got stuck on the page', 'Make the workflow brief more specific (name the buttons or pages to visit), then retry.'],
  [/frozen|silence|quality check|MP4|render|ffmpeg|captions/i, 'The finished video failed its quality check', 'Retry the render. Your recorded conversation is kept and you are not charged twice.'],
  [/sandbox|desktop|Computer Use|agent-browser|daemon|socket/i, 'The recording computer had a problem', 'Retry. The app will clear stale browser-controller state and reconnect automatically.'],
  [/too short|too long|fragment/i, 'An AI answer didn’t meet the length rules', 'Resume the episode; the guest will be asked to answer again.'],
];

export function friendlyError(message) {
  const text = String(message || '').trim();
  if (!text) return null;
  const match = rules.find(([pattern]) => pattern.test(text));
  return match ? { title: match[1], hint: match[2], detail: text } : { title: 'Something went wrong', hint: 'Retry. If it happens again, share the details below with support.', detail: text };
}
