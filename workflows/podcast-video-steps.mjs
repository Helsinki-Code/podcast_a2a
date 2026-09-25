import { episode, setEpisodeFields, putNamedAsset } from '../lib/store.mjs';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function transcodeInBackground(sandbox) {
  const launch = await sandbox.run('sh', ['-lc', "rm -f /tmp/podcast.mp4 /tmp/podcast-transcode.status /tmp/podcast-transcode.log /tmp/podcast-transcode.pid; nohup sh -c 'ffmpeg -nostdin -hide_banner -loglevel error -y -fflags +genpts -i /tmp/podcast.webm -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart /tmp/podcast.mp4; code=$?; echo $code > /tmp/podcast-transcode.status' >/tmp/podcast-transcode.log 2>&1 </dev/null & echo $! > /tmp/podcast-transcode.pid"], 30000);
  if (launch.exitCode !== 0) throw new Error(`Could not start MP4 conversion: ${(await launch.stderr()).slice(-1200)}`);
  for (let attempt = 0; attempt < 1500; attempt++) {
    const status = await sandbox.run('sh', ['-lc', 'test -f /tmp/podcast-transcode.status && cat /tmp/podcast-transcode.status'], 30000);
    if (status.exitCode === 0) {
      const code = Number((await status.stdout()).trim());
      if (code !== 0) {
        const log = await sandbox.run('sh', ['-lc', 'tail -c 2400 /tmp/podcast-transcode.log 2>/dev/null || true'], 30000);
        throw new Error(`MP4 conversion failed: ${(await log.stdout()).trim() || `ffmpeg exited ${code}`}`);
      }
      const probe = await sandbox.run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'default=noprint_wrappers=1', '/tmp/podcast.mp4'], 30000);
      if (probe.exitCode !== 0) throw new Error(`MP4 validation failed: ${(await probe.stderr()).slice(-1200)}`);
      return;
    }
    await wait(1000);
  }
  await sandbox.run('sh', ['-lc', 'test -f /tmp/podcast-transcode.pid && kill $(cat /tmp/podcast-transcode.pid) 2>/dev/null || true'], 30000).catch(() => {});
  throw new Error('MP4 conversion exceeded the 25-minute processing limit.');
}

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
    await transcodeInBackground(sandbox);
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
