import { episode, setEpisodeFields, putNamedAsset } from '../lib/store.mjs';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';

export async function transcodePodcastVideo(episodeId, pathname) {
  'use step';
  const item = await episode(episodeId);
  if (!item) throw new Error('Podcast not found.');
  if (item.settings?.outputFormat === 'webm') {
    await setEpisodeFields(episodeId, { videoStatus: 'complete' });
    return null;
  }
  await setEpisodeFields(episodeId, { videoStatus: 'processing', videoError: null });
  const { get } = await import('@vercel/blob');
  const source = await get(pathname, { access: 'private', useCache: false });
  if (!source?.stream) throw new Error('The uploaded WebM could not be read.');
  const input = Buffer.from(await new Response(source.stream).arrayBuffer());
  if (!input.length) throw new Error('The uploaded WebM is empty.');
  const sandbox = new VercelEpisodeSandbox(`video-${episodeId}`, () => {});
  try {
    await sandbox.writeSandboxFile('/tmp/podcast.webm', input);
    const result = await sandbox.run('ffmpeg', ['-y', '-fflags', '+genpts', '-i', '/tmp/podcast.webm', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '/tmp/podcast.mp4'], 25 * 60 * 1000);
    if (result.exitCode) throw new Error(`MP4 conversion failed: ${(await result.stderr()).slice(-1600)}`);
    const output = await sandbox.readSandboxFile('/tmp/podcast.mp4');
    if (!output?.length) throw new Error('MP4 conversion produced an empty file.');
    const mp4 = await putNamedAsset(`episode-${episodeId}.mp4`, output);
    await setEpisodeFields(episodeId, { mp4, videoStatus: 'complete', videoError: null });
    return mp4;
  } finally {
    await sandbox.close().catch(() => {});
  }
}

export async function failPodcastVideo(episodeId, message) {
  'use step';
  await setEpisodeFields(episodeId, { videoStatus: 'failed', videoError: String(message || 'MP4 conversion failed.').slice(0, 2000) });
}
