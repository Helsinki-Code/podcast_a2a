import '../lib/env.mjs';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';

const browser = new VercelEpisodeSandbox(`production-ui-${Date.now()}`, () => {});
try {
  await browser.setViewport(1440, 1000);
  await browser.command(['open', 'https://dsalesforge.online/']);
  const initial = await browser.command(['snapshot', '-i', '-c']);
  if (!/THE SALES FORGE/i.test(initial.stdout) || !/Choose a paid plan/i.test(initial.stdout)) throw new Error('Production landing page content is missing.');
  const signIn = initial.stdout.match(/button\s+"?Sign in"?\s+\[ref=([^\]]+)\]/i) || initial.stdout.match(/\[ref=([^\]]+)\][^\n]*Sign in/i);
  if (!signIn) throw new Error('The production sign-in button was not found.');
  await browser.command(['click', `@${signIn[1].replace(/^@/, '')}`]);
  await browser.command(['wait', '1200']);
  const modal = await browser.command(['snapshot', '-i', '-c']);
  if (!/sign in|continue with|email address/i.test(modal.stdout)) throw new Error('Clerk sign-in did not open.');
  console.log('production UI verified: landing, paid pricing, Clerk sign-in');
} finally {
  await browser.close().catch(() => {});
}
