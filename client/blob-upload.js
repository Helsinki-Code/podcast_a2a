import { upload } from '@vercel/blob/client';

window.uploadPodcastVideo = async (episodeId, video) => {
  const pathname = `assets/episode-${episodeId}-${crypto.randomUUID()}.webm`;
  const result = await upload(pathname, video, {
    access: 'private',
    handleUploadUrl: '/api/blob/upload',
    clientPayload: episodeId,
    multipart: true
  });
  return result.pathname;
};
