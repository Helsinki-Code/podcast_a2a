import { renderShorts, translateMedia, dubMedia, failPublishJob, uploadYoutube, failYoutubeUpload } from './publish-steps.mjs';

export async function shortsWorkflow(kind, id) {
  'use workflow';
  try { await renderShorts(kind, id); }
  catch (error) { await failPublishJob(kind, id, 'shorts', error.message); }
}

export async function translateWorkflow(kind, id, language) {
  'use workflow';
  try { await translateMedia(kind, id, language); }
  catch (error) { await failPublishJob(kind, id, 'translate', error.message, language); }
}

export async function dubWorkflow(kind, id, language) {
  'use workflow';
  try { await dubMedia(kind, id, language); }
  catch (error) { await failPublishJob(kind, id, 'dub', error.message, language); }
}

export async function youtubeUploadWorkflow(kind, id, options = {}) {
  'use workflow';
  try { await uploadYoutube(kind, id, options); }
  catch (error) { await failYoutubeUpload(kind, id, error.message); }
}
