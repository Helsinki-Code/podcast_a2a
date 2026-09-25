import '../lib/env.mjs';
import { writeFile } from 'node:fs/promises';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';

const browser = new VercelEpisodeSandbox(`computer-input-${Date.now()}`, () => {});
try {
  await browser.command(['open', 'https://example.com']);
  const screen = await browser.capture(null, 'https://example.com');
  const ref = screen.content.match(/link[^\n]*\[ref=(e\d+)\]/i)?.[1];
  if (!ref) throw new Error(`No link ref found in ${screen.content}`);
  await browser.startVideo('/tmp/computer-use-input.mkv');
  await browser.performComputerAction({ type: 'click', selector: `@${ref}`, x: 430, y: 385 });
  const destination = await browser.capture(null, 'https://www.iana.org/help/example-domains');
  if (!/iana\.org/i.test(destination.title)) throw new Error(`The real pointer click did not navigate: ${destination.title}`);
  await browser.command(['open', 'https://httpbin.org/forms/post']);
  const form = await browser.capture(null, 'https://httpbin.org/forms/post');
  const textbox = form.content.match(/(?:textbox|input|textarea)[^\n]*\[ref=(e\d+)\]/i)?.[1];
  if (!textbox) throw new Error('No public form field was available for the typing check.');
  const typedText = 'Human paced Computer Use walkthrough';
  await browser.performComputerAction({ type: 'type', selector: `@${textbox}`, x: 620, y: 360, text: typedText });
  const value = await browser.command(['get', 'value', `@${textbox}`]);
  if (!String(value.stdout).includes(typedText)) throw new Error(`The real keyboard did not type the expected value: ${value.stdout}`);
  await browser.performComputerAction({ type: 'scroll', direction: 'down', amount: 5 });
  await browser.stopVideo();
  const encoded = await browser.run('ffmpeg', ['-y', '-i', '/tmp/computer-use-input.mkv', '-an', '-c:v', 'copy', '-movflags', '+faststart', '/tmp/computer-use-input.mp4'], 5 * 60 * 1000);
  if (encoded.exitCode !== 0) throw new Error(await encoded.stderr());
  const video = await browser.readSandboxFile('/tmp/computer-use-input.mp4');
  await writeFile('/tmp/computer-use-input.mp4', video);
  console.log(`computer use input verified: click, navigation, ${typedText.length} typed characters, gradual scroll, ${video.length} byte MP4 · /tmp/computer-use-input.mp4`);
} finally {
  await browser.close().catch(() => {});
}
