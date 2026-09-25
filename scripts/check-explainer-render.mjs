import '../lib/env.mjs';
import { writeFile } from 'node:fs/promises';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';
import { buildCaptions, explainerCaptionFilter, normalizeSceneVideo } from '../workflows/explainer-steps.mjs';

const id = `render-check-${Date.now()}`;
const browser = new VercelEpisodeSandbox(id, () => {});
try {
  await browser.setViewport(1280, 720);
  await browser.command(['open', 'https://dsalesforge.online']);
  await browser.startVideo('/tmp/check.webm');
  await browser.command(['wait', '900']);
  await browser.command(['scroll', 'down', '650']);
  await browser.command(['wait', '1300']);
  await browser.stopVideo();
  await browser.capture(null, 'https://dsalesforge.online');
  const normalized = await normalizeSceneVideo(browser, '/tmp/check.webm', '/tmp/check-normalized.mp4', 2.2);
  if (normalized.usedScreenshotFallback) throw new Error('A valid browser recording unexpectedly needed the screenshot fallback.');
  await browser.writeSandboxFile('/tmp/corrupt.webm', 'not a webm recording');
  const recovered = await normalizeSceneVideo(browser, '/tmp/corrupt.webm', '/tmp/check-recovered.mp4', 2.2);
  if (!recovered.usedScreenshotFallback) throw new Error('The corrupt-recording check did not use the screenshot fallback.');
  await browser.writeSandboxFile('/tmp/check-videos.txt', "file '/tmp/check-normalized.mp4'\nfile '/tmp/check-recovered.mp4'");
  let result = await browser.run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', '/tmp/check-videos.txt', '-c', 'copy', '-movflags', '+faststart', '/tmp/check-picture.mp4']);
  if (result.exitCode) throw new Error(await result.stderr());
  const captions = buildCaptions([{ text: 'The browser moves through the live page while short captions preserve a clear view of the interface.', duration: 2.2 }, { text: 'A corrupt capture recovers without turning the subtitle track into a paragraph.', duration: 2.2 }]);
  await browser.writeSandboxFile('/tmp/check.srt', captions);
  result = await browser.run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '4.4', '-c:a', 'aac', '/tmp/check.m4a']);
  if (result.exitCode) throw new Error(await result.stderr());
  result = await browser.run('ffmpeg', ['-y', '-i', '/tmp/check-picture.mp4', '-i', '/tmp/check.m4a', '-vf', explainerCaptionFilter('studio', '/tmp/check.srt'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '/tmp/check.mp4'], 5 * 60 * 1000);
  if (result.exitCode) throw new Error(await result.stderr());
  const video = await browser.readSandboxFile('/tmp/check.mp4');
  if (!video || video.length < 10_000) throw new Error('Rendered video is unexpectedly small.');
  const localPreview = '/tmp/sales-forge-explainer-render-check.mp4';
  await writeFile(localPreview, video);
  console.log(`explainer render verified: ${video.length} bytes · ${localPreview}`);
} finally {
  await browser.close().catch(() => {});
}
