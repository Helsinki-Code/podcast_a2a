import { notifyOwner } from '../lib/notify.mjs';
import { captureError } from '../lib/monitor.mjs';
import { enterUsage } from '../lib/usage.mjs';
import { episode, setEpisodeFields, refundCredits, stamp } from '../lib/store.mjs';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';
import { podcastTimeline } from '../lib/podcast-timeline.mjs';
import { assemblePodcast } from '../lib/podcast-assembly.mjs';

const safe = value => String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_');

export async function renderPodcastTimeline(episodeId) {
  'use step';
  const item = await episode(episodeId);
  enterUsage({ ownerId: item?.ownerId, kind: 'podcast', id: episodeId });
  if (!item) throw new Error('Podcast not found.');
  await setEpisodeFields(episodeId, { videoStatus: 'processing', videoError: null });
  const sourceTimeline = podcastTimeline(item.events || [], { gap: 0 });
  const speechCount = sourceTimeline.filter(entry => entry.type === 'speech').length;
  const browserCount = sourceTimeline.filter(entry => entry.video).length;
  if (speechCount < 2) throw new Error('The podcast has too little completed speech to render.');
  if (item.settings?.requireGuestDemo && browserCount < 1) throw new Error('The required guest Computer Use demonstration is missing from the podcast timeline.');
  const browser = new VercelEpisodeSandbox(`render-${episodeId}`, () => {});
  try {
    const fields = await assemblePodcast(browser, item, sourceTimeline, { stem: `episode-${safe(episodeId)}` });
    await setEpisodeFields(episodeId, { ...fields, videoStatus: 'complete', renderedAt: stamp() });
    await notifyOwner(item.ownerId, `Your podcast is ready: ${item.title || item.outline?.subject}`, 'The finished video, captions, transcript, audio, and thumbnail are ready to download and publish.');
    return fields.mp4;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function failPodcastRender(episodeId, message) {
  'use step';
  await captureError(new Error(message || 'Podcast rendering failed.'), { kind: 'podcast', id: episodeId, stage: 'render' });
  const item = await episode(episodeId);
  if (item?.creditsCharged && item.ownerId) await refundCredits(item.ownerId, item.creditsCharged, 'podcast', item.creditReference || episodeId);
  const reason = String(message || 'Podcast rendering failed.').slice(0, 2000);
  await setEpisodeFields(episodeId, { videoStatus: 'failed', videoError: reason, creditsCharged: 0, ...(item?.endedAt ? {} : { endedAt: stamp() }) });
}
