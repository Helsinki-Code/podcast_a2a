import '../lib/env.mjs';
import { writeFile } from 'node:fs/promises';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';
import { buildCaptions, explainerCaptionFilter, normalizeSceneVideo } from '../workflows/explainer-steps.mjs';

const id = `render-check-${Date.now()}`;
const browser = new VercelEpisodeSandbox(id, () => {});
try {
  await browser.setViewport(1280, 720);
  await browser.command(['open', 'https://example.com']);
  await browser.capture(null, 'https://example.com');
  await browser.startVideo('/tmp/check.webm');
  await browser.command(['wait', '450']);
  await browser.performBrowserAction({ type: 'click', selector: '@e2' });
  await browser.performBrowserAction({ type: 'scroll', direction: 'down', amount: 650 });
  await browser.command(['wait', '700']);
  await browser.stopVideo();
  await browser.capture(null, 'https://www.iana.org/help/example-domains');
  const normalized = await normalizeSceneVideo(browser, '/tmp/check.webm', '/tmp/check-normalized.mp4', 5.5);
  if (normalized.usedScreenshotFallback) throw new Error('A valid browser recording unexpectedly needed the screenshot fallback.');
  await browser.command(['open', 'https://httpbin.org/forms/post']);
  const formScreen = await browser.capture(null, 'https://httpbin.org/forms/post');
  const textboxRef = formScreen.content.match(/(?:textbox|input|textarea)[^\n]*\[ref=(e\d+)\]/i)?.[1];
  if (!textboxRef) throw new Error('The live keyboard check could not find a form field.');
  await browser.startVideo('/tmp/check-typing.webm');
  await browser.command(['wait', '450']);
  await browser.performBrowserAction({ type: 'type', selector: `@${textboxRef}`, value: 'Human paced browser walkthrough' });
  await browser.command(['wait', '700']);
  await browser.stopVideo();
  const typed = await normalizeSceneVideo(browser, '/tmp/check-typing.webm', '/tmp/check-typing.mp4', 4);
  if (typed.usedScreenshotFallback) throw new Error('The live typing recording unexpectedly needed the screenshot fallback.');
  await browser.writeSandboxFile('/tmp/corrupt.webm', 'not a webm recording');
  let rejected = false;
  try { await normalizeSceneVideo(browser, '/tmp/corrupt.webm', '/tmp/check-recovered.mp4', 2.2); }
  catch { rejected = true; }
  if (!rejected) throw new Error('The corrupt recording was accepted instead of being rejected.');
  await browser.writeSandboxFile('/tmp/check-videos.txt', "file '/tmp/check-normalized.mp4'\nfile '/tmp/check-typing.mp4'");
  let result = await browser.run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', '/tmp/check-videos.txt', '-c', 'copy', '-movflags', '+faststart', '/tmp/check-picture.mp4']);
  if (result.exitCode) throw new Error(await result.stderr());
  const captions = buildCaptions([{ text: 'The cursor moves naturally to the link while narration explains the destination.', duration: 5.5, captionDuration: 4.4 }, { text: 'The agent types into the form with visible human paced keystrokes.', duration: 4, captionDuration: 3.2 }], { wordsPerCue: 5 });
  await browser.writeSandboxFile('/tmp/check.srt', captions);
  result = await browser.run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '9.5', '-c:a', 'aac', '/tmp/check.m4a']);
  if (result.exitCode) throw new Error(await result.stderr());
  result = await browser.run('ffmpeg', ['-y', '-i', '/tmp/check-picture.mp4', '-i', '/tmp/check.m4a', '-vf', explainerCaptionFilter({ style: 'bold', font: 'mono', size: 23, textColor: '#80ded1', backgroundColor: '#101c24', position: 'top' }, '/tmp/check.srt'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '/tmp/check.mp4'], 5 * 60 * 1000);
  if (result.exitCode) throw new Error(await result.stderr());
  const video = await browser.readSandboxFile('/tmp/check.mp4');
  if (!video || video.length < 10_000) throw new Error('Rendered video is unexpectedly small.');
  const localPreview = '/tmp/sales-forge-explainer-render-check.mp4';
  await writeFile(localPreview, video);
  console.log(`explainer render verified: ${video.length} bytes · ${localPreview}`);
} finally {
  await browser.close().catch(() => {});
}
