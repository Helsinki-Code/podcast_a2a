// Publish dialog for a finished podcast or explainer: YouTube package and upload, every download
// format, vertical shorts, translations and dubs, and (podcasts) the RSS feed.
const LANGUAGES = { es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', nl: 'Dutch', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', hi: 'Hindi', ar: 'Arabic', en: 'English' };
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let ctx = null;

const base = () => `/api/${ctx.kind === 'podcast' ? 'episodes' : 'explainers'}/${ctx.item.id}`;
const busy = item => item.shortsStatus === 'processing' || item.youtubeUpload?.status === 'uploading' || Object.values(item.translations || {}).some(entry => entry.status === 'processing' || entry.dubStatus === 'processing');

function downloads(item) {
  const links = [
    item.mp4 || (ctx.kind === 'explainer' && item.video) ? ['MP4 video', item.mp4 || item.video] : null,
    ctx.kind === 'podcast' && item.video?.endsWith('.webm') ? ['WebM video', item.video] : null,
    item.mp3?.url ? ['MP3 audio', item.mp3.url] : null,
    item.thumbnail ? ['Thumbnail', item.thumbnail] : null
  ].filter(Boolean);
  const exports = item.timeline?.length ? [['SRT captions', 'srt'], ['WebVTT captions', 'vtt'], ['Word-level SRT', 'words'], ['Transcript (TXT)', 'txt'], ['Transcript (JSON)', 'json']] : [];
  return `<div class="publish-links">${links.map(([label, href]) => `<a href="${esc(href)}" download>${esc(label)}</a>`).join('')}${exports.map(([label, format]) => `<a href="${base()}/export?format=${format}" download>${esc(label)}</a>`).join('')}</div>`;
}

function youtubeSection(item) {
  const meta = item.youtube || {};
  const upload = item.youtubeUpload || {};
  const yt = ctx.integrations?.youtube || {};
  const action = !yt.configured ? '<p class="hint">YouTube upload is not configured on this workspace. Copy the title and description below.</p>'
    : !yt.connected ? '<button type="button" class="button button-ghost small" data-publish="connect-youtube">Connect YouTube</button>'
    : upload.status === 'uploading' ? '<span class="hint">Uploading to YouTube…</span>'
    : `<div class="form-row"><label>Visibility<select name="privacy"><option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option></select></label><button type="button" class="button button-primary small" data-publish="youtube">${upload.status === 'complete' ? 'Upload again' : `Upload to ${esc(yt.channel?.title || 'YouTube')}`}</button></div>`;
  return `<section class="publish-section"><h3>YouTube package</h3>${item.thumbnail ? `<img class="publish-thumb" src="${esc(item.thumbnail)}" alt="Generated thumbnail">` : ''}<label>Title<input name="ytTitle" maxlength="100" value="${esc(meta.title || '')}"></label><label>Description<textarea name="ytDescription" rows="6">${esc(meta.description || '')}</textarea></label>${meta.tags?.length ? `<p class="hint">Tags: ${meta.tags.map(esc).join(', ')}</p>` : ''}<div class="publish-actions"><button type="button" class="button button-ghost small" data-publish="copy">Copy title &amp; description</button></div>${action}${upload.status === 'complete' ? `<p class="publish-ok">Uploaded: <a href="${esc(upload.url)}" target="_blank" rel="noopener">${esc(upload.url)}</a>${upload.note ? ` · ${esc(upload.note)}` : ''}</p>` : ''}${upload.status === 'failed' ? `<p class="row-error">${esc(upload.error)}</p>` : ''}</section>`;
}

function shortsSection(item) {
  const costs = ctx.costs || {};
  const status = item.shortsStatus === 'processing' ? '<span class="hint">Cutting shorts…</span>' : `<button type="button" class="button button-ghost small" data-publish="shorts">${item.shorts?.length ? 'Make new shorts' : 'Make vertical shorts'} · ${costs.shorts ?? 5} credits</button>`;
  const list = (item.shorts || []).map(short => `<li><a href="${esc(short.video)}" download>${esc(short.title)}</a> <span class="hint">${Math.round(short.end - short.start)}s</span></li>`).join('');
  return `<section class="publish-section"><h3>Shorts (9:16)</h3><p class="hint">Up to three 15–58 second highlights for Shorts, Reels, and TikTok.</p>${list ? `<ul class="publish-list">${list}</ul>` : ''}${status}${item.shortsError ? `<p class="row-error">${esc(item.shortsError)}</p>` : ''}</section>`;
}

function languageSection(item) {
  const costs = ctx.costs || {};
  const dubCost = ctx.kind === 'podcast' ? costs.dubPodcast ?? 20 : costs.dubExplainer ?? 10;
  const rows = Object.entries(item.translations || {}).map(([code, entry]) => `<li><strong>${esc(LANGUAGES[code] || code)}</strong> ${entry.status === 'processing' ? '<span class="hint">translating…</span>' : entry.status === 'failed' ? `<span class="row-error">${esc(entry.error)}</span>` : `<a href="${base()}/export?format=srt&lang=${code}" download>SRT</a> <a href="${base()}/export?format=vtt&lang=${code}" download>VTT</a> <a href="${base()}/export?format=txt&lang=${code}" download>Transcript</a>`} ${entry.dubStatus === 'processing' ? '<span class="hint">dubbing…</span>' : entry.dubbedVideo ? `<a href="${esc(entry.dubbedVideo)}" download>Dubbed video</a>` : entry.dubStatus === 'failed' ? `<span class="row-error">${esc(entry.dubError)}</span>` : ''}</li>`).join('');
  return `<section class="publish-section"><h3>Other languages</h3>${rows ? `<ul class="publish-list">${rows}</ul>` : ''}<div class="form-row"><label>Language<select name="language">${Object.entries(LANGUAGES).map(([code, name]) => `<option value="${code}">${name}</option>`).join('')}</select></label></div><div class="publish-actions"><button type="button" class="button button-ghost small" data-publish="translate">Translate captions · ${costs.translation ?? 2} credits</button><button type="button" class="button button-ghost small" data-publish="dub">Dub the video · ${dubCost} credits</button></div><p class="hint">Dubbing re-voices every line in the chosen language and reuses the recorded picture.</p></section>`;
}

function feedSection(item) {
  if (ctx.kind !== 'podcast') return '';
  const feed = ctx.feed || {};
  if (!feed.token) return `<section class="publish-section"><h3>Podcast feed</h3><p class="hint">Publish episodes as audio to Apple Podcasts, Spotify, or any podcast app with a private RSS feed.</p><label>Show title<input name="feedTitle" maxlength="120" placeholder="My show"></label><button type="button" class="button button-ghost small" data-publish="create-feed">Create podcast feed</button></section>`;
  return `<section class="publish-section"><h3>Podcast feed</h3><label class="check-inline"><input type="checkbox" name="inFeed" ${item.inFeed ? 'checked' : ''} ${item.mp3?.url ? '' : 'disabled'}> Include this episode in “${esc(feed.title)}”</label><label>Feed URL <span class="hint">Paste into your podcast host or app. Anyone with the link can listen.</span><input readonly value="${esc(feed.url)}" onclick="this.select()"></label><button type="button" class="link-button" data-publish="rotate-feed">Reset the feed link</button></section>`;
}

function render() {
  const item = ctx.item;
  document.querySelector('#publishTitle').textContent = ctx.kind === 'podcast' ? item.outline?.subject : item.title;
  document.querySelector('#publishBody').innerHTML = `<section class="publish-section"><h3>Downloads</h3>${downloads(item)}${item.chapters?.length ? `<ol class="chapter-list">${item.chapters.map(chapter => `<li><span>${Math.floor(chapter.start / 60)}:${String(Math.floor(chapter.start % 60)).padStart(2, '0')}</span> ${esc(chapter.title)}</li>`).join('')}</ol>` : ''}</section>${youtubeSection(item)}${shortsSection(item)}${languageSection(item)}${feedSection(item)}`;
}

async function reload() {
  ctx.item = await ctx.api(base());
  render();
  clearTimeout(ctx.timer);
  if (busy(ctx.item) && document.querySelector('#publishDialog').open) ctx.timer = setTimeout(() => reload().catch(() => {}), 3500);
}

async function act(action, button) {
  const form = document.querySelector('#publishForm');
  const post = (path, body = {}) => ctx.api(`${base()}/${path}`, { method: 'POST', body: JSON.stringify(body) });
  button.disabled = true;
  try {
    if (action === 'copy') { await navigator.clipboard.writeText(`${form.elements.ytTitle.value}\n\n${form.elements.ytDescription.value}`); ctx.notice('Copied the title and description.', true); return; }
    if (action === 'connect-youtube') { const { url } = await ctx.api('/api/integrations/youtube/connect', { method: 'POST' }); window.location.assign(url); return; }
    if (action === 'youtube') await post('youtube', { privacy: form.elements.privacy.value, title: form.elements.ytTitle.value, description: form.elements.ytDescription.value });
    if (action === 'shorts') await post('shorts');
    if (action === 'translate' || action === 'dub') await post(action, { language: form.elements.language.value });
    if (action === 'create-feed' || action === 'rotate-feed') ctx.feed = await ctx.api('/api/feed', { method: 'PUT', body: JSON.stringify(action === 'rotate-feed' ? { rotate: true } : { title: form.elements.feedTitle.value || 'My podcast' }) });
    await ctx.refreshMe?.();
    await reload();
  } catch (error) { ctx.notice(error.message); } finally { button.disabled = false; }
}

export async function openPublishDialog(kind, item, helpers) {
  ctx = { kind, item, ...helpers };
  const [integrations, feed] = await Promise.all([helpers.api('/api/integrations').catch(() => ({})), kind === 'podcast' ? helpers.api('/api/feed').catch(() => ({})) : null]);
  Object.assign(ctx, { integrations, feed });
  render();
  document.querySelector('#publishDialog').showModal();
  reload().catch(() => {});
}

document.addEventListener('click', event => { const button = event.target.closest('[data-publish]'); if (button && ctx) act(button.dataset.publish, button); });
document.addEventListener('change', async event => {
  if (event.target.name !== 'inFeed' || !ctx) return;
  try { await ctx.api(`${base()}/feed`, { method: 'POST', body: JSON.stringify({ include: event.target.checked }) }); ctx.notice(event.target.checked ? 'Added to the podcast feed.' : 'Removed from the podcast feed.', true); }
  catch (error) { event.target.checked = !event.target.checked; ctx.notice(error.message); }
});
