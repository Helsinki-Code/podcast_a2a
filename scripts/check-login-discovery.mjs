import '../lib/env.mjs';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';

const cases = [
  { url: 'https://amrogen.com', route: /\/sign-in(?:[/?#]|$)/i },
  { url: 'https://github.com', route: /\/login(?:[/?#]|$)/i },
];

for (const target of cases) {
  const browser = new VercelEpisodeSandbox(`login-discovery-${Date.now()}-${new URL(target.url).hostname.replace(/[^a-z0-9_-]/gi, '-')}`, () => {});
  try {
    const url = await browser.locateLoginPage({
      url: target.url,
      usernameSelector: 'input[type="email"], input[name="email"], input[name="username"]',
    });
    const snapshot = await browser.command(['snapshot', '-i', '-c']);
    let text = String(snapshot.stdout || '');
    try { text = String(JSON.parse(text)?.data?.snapshot || text); } catch {}
    if (!target.route.test(url)) throw new Error(`Expected a login route for ${target.url}, received ${url}`);
    if (!/textbox|input/i.test(text)) throw new Error(`No login input was visible at ${url}.`);
    console.log(`login discovery verified: ${url}`);
  } finally {
    await browser.close().catch(() => {});
  }
}
