import { modelProviders } from './providers.mjs';
import { modelFor } from './models.mjs';
import { putNamedAsset, readAssetBytes } from './store.mjs';
import { ffmetadata } from './chapters.mjs';
import { metadataPrompt, podcastChapters, thumbnailHtml, youtubeDescription } from './publishing.mjs';

// Runs inside a render step with its sandbox: builds everything a finished video ships with.
// Every part is best-effort, so a metadata or thumbnail problem never fails a finished render.
const safe = value => String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_');

export async function generateMetadata(kind, item, timeline) {
  const provider = modelProviders.get('gateway');
  if (!provider?.ready?.()) return null;
  try {
    const result = await provider.generate(metadataPrompt(kind, item, timeline), modelFor('metadata'), { user: item.ownerId, tags: [`feature:${kind}-metadata`] });
    return {
      title: String(result?.title || '').trim().slice(0, 100),
      description: String(result?.description || '').trim().slice(0, 3000),
      tags: Array.isArray(result?.tags) ? result.tags.map(tag => String(tag).trim().toLowerCase()).filter(Boolean).slice(0, 15) : [],
      chapterTitles: Array.isArray(result?.chapterTitles) ? result.chapterTitles.map(String) : [],
      thumbnailText: String(result?.thumbnailText || '').trim().slice(0, 40)
    };
  } catch { return null; }
}

async function makeThumbnail(browser, item, { finalPath, totalDuration, text, stem, accent }) {
  const at = Math.max(0.5, totalDuration * 0.35).toFixed(2);
  let result = await browser.run('ffmpeg', ['-y', '-ss', at, '-i', finalPath, '-frames:v', '1', '-q:v', '3', '/tmp/thumb-frame.jpg'], 60000);
  if (result.exitCode) return null;
  const frame = await browser.readSandboxFile('/tmp/thumb-frame.jpg');
  const logo = item.brand?.logo ? await readAssetBytes(item.brand.logo).catch(() => null) : null;
  const logoData = logo?.length ? `data:image/${/\.svg$/i.test(item.brand.logo) ? 'svg+xml' : /\.jpe?g$/i.test(item.brand.logo) ? 'jpeg' : 'png'};base64,${logo.toString('base64')}` : '';
  await browser.writeSandboxFile('/tmp/thumb.html', thumbnailHtml({ frame: `data:image/jpeg;base64,${frame.toString('base64')}`, text, logo: logoData, accent }));
  await browser.setViewport(1920, 1080);
  await browser.command(['open', 'file:///tmp/thumb.html']);
  await browser.command(['wait', '300']);
  await browser.command(['screenshot', '/tmp/thumb-full.png']);
  result = await browser.run('ffmpeg', ['-y', '-i', '/tmp/thumb-full.png', '-vf', 'scale=1280:720:flags=lanczos', '-q:v', '2', '/tmp/thumb.jpg'], 60000);
  if (result.exitCode) return null;
  return putNamedAsset(`${stem}-thumbnail.jpg`, await browser.readSandboxFile('/tmp/thumb.jpg'));
}

// Returns { youtube, thumbnail, mp3, chapters, finalPath } — finalPath may point at a copy with chapters.
export async function packageVideo(browser, { kind, item, finalPath, timeline, totalDuration, chapters = null, stem, accent = '#80ded1', metadata: provided }) {
  const metadata = provided === undefined ? await generateMetadata(kind, item, timeline) : provided;
  const finalChapters = chapters || (kind === 'podcast' ? podcastChapters(timeline, totalDuration, metadata?.chapterTitles || []) : []);
  let packagedPath = finalPath;
  if (kind === 'podcast' && finalChapters.length) {
    await browser.writeSandboxFile('/tmp/publish-chapters.txt', ffmetadata(finalChapters, totalDuration, { title: metadata?.title || item.outline?.subject }));
    const result = await browser.run('ffmpeg', ['-y', '-i', finalPath, '-i', '/tmp/publish-chapters.txt', '-map', '0', '-map_metadata', '1', '-map_chapters', '1', '-c', 'copy', '-movflags', '+faststart', '/tmp/publish-chaptered.mp4'], 5 * 60 * 1000);
    if (!result.exitCode) packagedPath = '/tmp/publish-chaptered.mp4';
  }
  const title = metadata?.title || (kind === 'podcast' ? item.outline?.subject : item.title) || 'Untitled';
  const thumbnail = await makeThumbnail(browser, item, { finalPath: packagedPath, totalDuration, text: metadata?.thumbnailText || title, stem, accent }).catch(() => null);
  let mp3 = null;
  const audio = await browser.run('ffmpeg', ['-y', '-i', packagedPath, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-id3v2_version', '3', '-metadata', `title=${title}`, '/tmp/publish-audio.mp3'], 10 * 60 * 1000);
  if (!audio.exitCode) {
    const bytes = await browser.readSandboxFile('/tmp/publish-audio.mp3');
    mp3 = { url: await putNamedAsset(`${stem}.mp3`, bytes), bytes: bytes.length, duration: totalDuration };
  }
  return {
    finalPath: packagedPath, thumbnail, mp3, chapters: finalChapters,
    youtube: { title, description: youtubeDescription(metadata, finalChapters, item.brand), tags: metadata?.tags || [], thumbnailText: metadata?.thumbnailText || '' }
  };
}

export { safe as safeStem };
