import '../lib/env.mjs';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';

const browser = new VercelEpisodeSandbox(`production-ui-${Date.now()}`, () => {});
const snapshotText = result => { try { return JSON.parse(result.stdout).data.snapshot; } catch { return result.stdout; } };
try {
  await browser.setViewport(1440, 1000);
  await browser.command(['open', 'https://dsalesforge.online/']);
  const initial = snapshotText(await browser.command(['snapshot', '-i', '-c']));
  if (!/THE SALES FORGE/i.test(initial) || !/Choose a paid plan/i.test(initial)) throw new Error('Production landing page content is missing.');
  const signIn = initial.match(/button\s+"?Sign in"?\s+\[ref=([^\]]+)\]/i) || initial.match(/\[ref=([^\]]+)\][^\n]*Sign in/i);
  if (!signIn) throw new Error('The production sign-in button was not found.');
  await browser.command(['click', '#signInButton']);
  await browser.command(['wait', '2500']);
  const modal = snapshotText(await browser.command(['snapshot', '-i', '-c']));
  if (!/email address|continue with/i.test(modal)) {
    const [errors, consoleMessages, full] = await Promise.all([browser.command(['errors']).catch(error => ({ stdout: error.message })), browser.command(['console']).catch(error => ({ stdout: error.message })), browser.command(['snapshot']).catch(error => ({ stdout: error.message }))]);
    throw new Error(`Clerk sign-in did not open.\nErrors: ${errors.stdout}\nConsole: ${consoleMessages.stdout}\nPage: ${snapshotText(full).slice(0, 3000)}`);
  }
  console.log('production UI verified: landing, paid pricing, Clerk sign-in');
} finally {
  await browser.close().catch(() => {});
}
