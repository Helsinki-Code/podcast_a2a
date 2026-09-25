import { renderPodcastTimeline, failPodcastRender } from './podcast-render-steps.mjs';

// Re-runs only the MP4 assembly for a finished conversation, e.g. after a render failure.
export async function podcastRenderWorkflow(episodeId) {
  'use workflow';
  try { await renderPodcastTimeline(episodeId); }
  catch (error) { await failPodcastRender(episodeId, error.message || 'Podcast rendering failed.'); }
}
