import '../lib/env.mjs';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';

const id = `render-check-${Date.now()}`;
const browser = new VercelEpisodeSandbox(id, () => {});
try {
  await browser.setViewport(1280, 720);
  await browser.command(['open', 'https://example.com']);
  await browser.startVideo('/tmp/check.webm');
  await browser.command(['wait', '2200']);
  await browser.stopVideo();
  await browser.writeSandboxFile('/tmp/check.srt', '1\n00:00:00,000 --> 00:00:02,000\nThe Sales Forge render check\n');
  let result = await browser.run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '2.2', '-c:a', 'aac', '/tmp/check.m4a']);
  if (result.exitCode) throw new Error(await result.stderr());
  result = await browser.run('ffmpeg', ['-y', '-i', '/tmp/check.webm', '-i', '/tmp/check.m4a', '-vf', 'subtitles=/tmp/check.srt', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '/tmp/check.mp4'], 5 * 60 * 1000);
  if (result.exitCode) throw new Error(await result.stderr());
  const video = await browser.readSandboxFile('/tmp/check.mp4');
  if (!video || video.length < 10_000) throw new Error('Rendered video is unexpectedly small.');
  console.log(`explainer render verified: ${video.length} bytes`);
} finally {
  await browser.close().catch(() => {});
}
