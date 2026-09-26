import { $, $$, esc, state, api, notice, busy, shortDate, clock, itemTitle, episodePerson, statusLabel, errorMarkup, canEdit, refreshData, refreshMe, confirmDialog, promptDialog, skeleton } from './core.js';
import { castRoles, roleLabel } from './cast.js';
import { openPublishDialog } from './publish.js';

// One library for podcasts and explainers: search, type tabs, status filter, sort, and per-item
// actions (open, publish, rename, duplicate, delete, and the next step for its status).
const view = { type: 'all', query: '', status: '', sort: 'newest' };
const ACTIVE = ['running', 'preparing', 'queued', 'planning', 'rendering'];

export function libraryItems() {
  return [...state.episodes.map(item => ({ kind: 'podcast', item })), ...state.explainers.map(item => ({ kind: 'explainer', item }))];
}

function bucket({ kind, item }) {
  if (ACTIVE.includes(item.status) || item.videoStatus === 'processing') return 'active';
  if (item.status === 'failed' || item.videoStatus === 'failed' || item.status === 'awaiting_approval' || item.status === 'interrupted') return 'attention';
  if (item.status === 'draft') return 'draft';
  return (kind === 'podcast' ? item.mp4 || item.video : item.video) ? 'ready' : 'attention';
}

function searchable({ kind, item }) {
  const people = kind === 'podcast' ? castRoles(item).map(role => episodePerson(item, role)?.name).join(' ') : item.url;
  return `${itemTitle(kind, item)} ${item.outline?.subject || ''} ${item.brief || ''} ${people}`.toLowerCase();
}

function subtitle({ kind, item }) {
  if (kind === 'podcast') return `${castRoles(item).map(role => episodePerson(item, role)?.name || roleLabel(role)).join(' × ')}${item.duration ? ` · ${clock(item.duration)}` : item.turns?.length ? ` · ${item.turns.length} lines` : ''}`;
  let host = ''; try { host = new URL(item.url).hostname; } catch {}
  return `${host}${item.duration ? ` · ${clock(item.duration)}` : ''}${item.progress && ACTIVE.includes(item.status) ? ` · ${item.progress}` : ''}`;
}

function primaryAction({ kind, item }) {
  if (kind === 'podcast') {
    if (item.status === 'draft') return ['open', 'Open studio'];
    if (['failed', 'interrupted'].includes(item.status) && item.turns?.length) return ['open', 'Resume'];
    return ['open', ACTIVE.includes(item.status) ? 'Watch live' : 'Open'];
  }
  if (item.status === 'awaiting_approval') return ['review-plan', 'Review scene plan'];
  if (item.status === 'draft' && item.authRequired) return ['retry-signin', 'Resume sign-in'];
  if (item.status === 'complete' && item.video) return ['publish', 'Publish'];
  return null;
}

function card(entry) {
  const { kind, item } = entry;
  const primary = primaryAction(entry);
  const video = kind === 'podcast' ? item.mp4 || item.video : item.video;
  const menu = [
    video && item.status === 'complete' || (kind === 'podcast' && item.mp4) ? ['publish', 'Publish…'] : null,
    video ? ['download', 'Download video'] : null,
    kind === 'explainer' && item.status === 'complete' && item.scenes?.length && canEdit() ? ['rerender', 'Edit narration & re-render'] : null,
    canEdit() ? ['rename', 'Rename'] : null,
    canEdit() && !ACTIVE.includes(item.status) ? ['duplicate', 'Duplicate as draft'] : null,
    canEdit() && ['complete', 'stopped', 'failed', 'interrupted'].includes(item.status) ? ['restart', `Record again · ${kind === 'podcast' ? 20 : 30} credits`] : null,
    canEdit() && !ACTIVE.includes(item.status) ? ['delete', 'Delete'] : null
  ].filter(Boolean);
  const thumb = item.thumbnail ? `<img src="${esc(item.thumbnail)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'thumb-placeholder ${kind}',textContent:'${kind === 'podcast' ? '◉' : '▶'}'}))">` : `<span class="thumb-placeholder ${kind}" aria-hidden="true">${kind === 'podcast' ? '◉' : '▶'}</span>`;
  const error = item.status === 'failed' ? item.error : item.videoStatus === 'failed' ? item.videoError : item.rerenderError || '';
  return `<article class="library-card" data-kind="${kind}" data-id="${esc(item.id)}">
    <button type="button" class="thumb" data-action="open" aria-label="Open ${esc(itemTitle(kind, item))}">${thumb}${item.duration ? `<span class="thumb-time">${clock(item.duration)}</span>` : ''}</button>
    <div class="library-body"><div class="library-meta"><span class="kind-label">${kind === 'podcast' ? 'Podcast' : 'Explainer'}</span><span class="tag ${esc(item.status)}">${esc(statusLabel(item.status))}</span>${item.videoStatus === 'processing' ? '<span class="tag running">Rendering</span>' : ''}${item.inFeed ? '<span class="tag">In feed</span>' : ''}<span class="hint">${shortDate(item.createdAt)}</span></div>
      <h3><button type="button" class="title-button" data-action="open">${esc(itemTitle(kind, item))}</button></h3><p>${esc(subtitle(entry))}</p>${error ? errorMarkup(error) : ''}</div>
    <div class="library-actions">${primary ? `<button type="button" class="button small ${primary[0] === 'publish' || primary[0] === 'review-plan' ? 'button-primary' : 'button-ghost'}" data-action="${primary[0]}">${primary[1]}</button>` : ''}${menu.length ? `<details class="menu"><summary aria-label="More actions for ${esc(itemTitle(kind, item))}">•••</summary><div class="menu-list" role="menu">${menu.map(([action, label]) => `<button type="button" role="menuitem" data-action="${action}" class="${action === 'delete' ? 'danger' : ''}">${label}</button>`).join('')}</div></details>` : ''}</div>
  </article>`;
}

export function renderLibrary() {
  const list = $('#libraryList');
  if (!list) return;
  if (!state.loaded) { list.innerHTML = skeleton(4, 'skeleton-card'); return; }
  const query = view.query.trim().toLowerCase();
  let items = libraryItems().filter(entry => (view.type === 'all' || entry.kind === view.type) && (!view.status || bucket(entry) === view.status) && (!query || searchable(entry).includes(query)));
  items.sort((a, b) => view.sort === 'title' ? itemTitle(a.kind, a.item).localeCompare(itemTitle(b.kind, b.item)) : view.sort === 'oldest' ? String(a.item.createdAt).localeCompare(String(b.item.createdAt)) : String(b.item.createdAt).localeCompare(String(a.item.createdAt)));
  const total = libraryItems().length;
  list.innerHTML = items.length ? items.map(card).join('') : `<div class="empty"><strong>${total ? 'Nothing matches' : 'Your library is empty'}</strong>${total ? 'Try another search or filter.' : 'Make a podcast or an explainer and it will appear here.'}${total ? '' : '<div class="empty-actions"><button class="button button-primary small" data-new="podcast">Make a podcast</button><button class="button button-ghost small" data-new="explainer">Make an explainer</button></div>'}</div>`;
}

async function act(action, kind, id, button) {
  const collection = kind === 'podcast' ? state.episodes : state.explainers;
  const item = collection.find(entry => entry.id === id);
  if (!item) return;
  const base = `/api/${kind === 'podcast' ? 'episodes' : 'explainers'}/${id}`;
  const helpers = { api, notice, refreshMe, costs: state.config?.costs };
  if (action === 'open') { if (kind === 'podcast') location.hash = `#/studio/${id}`; else if (item.status === 'complete' && item.video) openPublishDialog('explainer', item, helpers); else document.dispatchEvent(new CustomEvent('explainer:open', { detail: item })); return; }
  if (action === 'publish') return openPublishDialog(kind, kind === 'podcast' ? await api(base) : item, helpers).catch(error => notice(error.message));
  if (action === 'download') { const link = document.createElement('a'); link.href = kind === 'podcast' ? item.mp4 || item.video : item.video; link.download = ''; link.click(); return; }
  if (action === 'review-plan' || action === 'rerender' || action === 'retry-signin') { document.dispatchEvent(new CustomEvent(`explainer:${action}`, { detail: item })); return; }
  if (action === 'rename') {
    const title = await promptDialog({ title: 'Rename', label: 'Title', value: itemTitle(kind, item) });
    if (!title) return;
    try { await api(base, { method: 'PATCH', body: JSON.stringify({ title }) }); await refreshData(); notice('Renamed.', true); } catch (error) { notice(error.message); }
    return;
  }
  if (action === 'duplicate') { await busy(button, async () => { try { const copy = await api(`${base}/duplicate`, { method: 'POST' }); await refreshData(); notice('Duplicated as a draft.', true, kind === 'podcast' ? { action: { label: 'Open', run: () => { location.hash = `#/studio/${copy.id}`; } } } : {}); } catch (error) { notice(error.message); } }); return; }
  if (action === 'delete') {
    if (!await confirmDialog({ title: `Delete “${itemTitle(kind, item)}”?`, message: 'The video, audio, captions, and transcript are permanently deleted. This cannot be undone.', confirm: 'Delete permanently', danger: true })) return;
    try { await api(base, { method: 'DELETE' }); await refreshData(); notice('Deleted.', true); } catch (error) { notice(error.message); }
    return;
  }
  if (action === 'restart') { document.dispatchEvent(new CustomEvent(`${kind}:restart`, { detail: item })); }
}

export function initLibrary() {
  $('#librarySearch').addEventListener('input', event => { view.query = event.target.value; renderLibrary(); });
  $('#libraryStatus').addEventListener('change', event => { view.status = event.target.value; renderLibrary(); });
  $('#librarySort').addEventListener('change', event => { view.sort = event.target.value; renderLibrary(); });
  $$('[data-library-type]').forEach(tab => tab.addEventListener('click', () => setLibraryType(tab.dataset.libraryType)));
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    const card = button?.closest('.library-card');
    if (!card) return;
    button.closest('details')?.removeAttribute('open');
    act(button.dataset.action, card.dataset.kind, card.dataset.id, button).catch(error => notice(error.message));
  });
  document.addEventListener('click', event => { for (const menu of $$('.library-card details.menu[open]')) if (!menu.contains(event.target)) menu.removeAttribute('open'); });
}

export function setLibraryType(type) {
  view.type = ['podcast', 'explainer'].includes(type) ? type : 'all';
  $$('[data-library-type]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.libraryType === view.type)));
  renderLibrary();
}
