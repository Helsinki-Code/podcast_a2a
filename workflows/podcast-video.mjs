import { transcodePodcastVideo, failPodcastVideo } from './podcast-video-steps.mjs';

export async function podcastVideoWorkflow(episodeId, pathname) {
  'use workflow';
  try {
    await transcodePodcastVideo(episodeId, pathname);
  } catch (error) {
    await failPodcastVideo(episodeId, error.message || 'MP4 conversion failed.');
  }
}
