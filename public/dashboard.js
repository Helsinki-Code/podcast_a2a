import { $, esc, state, api, notice, busy, itemTitle, statusLabel, shortDate, avatar, money, refreshData, canEdit } from './core.js';
import { libraryItems } from './library.js';

// Overview: month-to-date numbers, a first-run checklist, recent work, and the cast.
const CHECKLIST_KEY = 'sales-forge-onboarding-hidden';

export async function loadStats() {
  try { state.stats = await api('/api/stats'); } catch { state.stats = null; }
  renderStats();
}

function renderStats() {
  const stats = state.stats, box = $('#statTiles');
  if (!box) return;
  if (!stats) { box.innerHTML = '<div class="stat-tile"><small>Stats</small><strong>—</strong><span>Unavailable right now</span></div>'; return; }
  const tiles = [
    ['Credits used', stats.creditsUsed, `${state.account?.credits ?? 0} left`],
    ['Videos made', stats.videosMade, 'podcasts and explainers, all time'],
    ['Success rate', stats.successRate == null ? '—' : `${stats.successRate}%`, `${stats.finishedThisMonth} finished · ${stats.failedThisMonth} failed this month`],
    ['AI cost (est.)', money(stats.estimatedCostUsd), 'model and voice usage this month']
  ];
  box.innerHTML = tiles.map(([label, value, note]) => `<div class="stat-tile"><small>${esc(label)}</small><strong>${esc(value)}</strong><span>${esc(note)}</span></div>`).join('');
}

function renderOnboarding(brandReady) {
  const box = $('#onboarding');
  let hidden = false;
  try { hidden = localStorage.getItem(CHECKLIST_KEY) === '1'; } catch {}
  const steps = [
    { done: state.personas.length >= 2, title: 'Create a host and a guest', text: 'Personas carry the voice, style, and knowledge of each speaker.', action: '<button type="button" class="button button-primary small" data-onboard="sample-cast">Create them for me</button><a class="link-button" href="#/personas">Or build your own</a>' },
    { done: state.episodes.some(item => item.status !== 'draft'), title: 'Record your first podcast', text: 'Pick a subject; the host and guest take it from there.', action: '<button type="button" class="button button-ghost small" data-new="podcast">New podcast</button>' },
    { done: state.explainers.some(item => !['draft'].includes(item.status)), title: 'Make your first explainer', text: 'Give the agent a URL and the workflow to show. You approve the plan first.', action: '<button type="button" class="button button-ghost small" data-new="explainer">New explainer</button>' },
    { done: brandReady, title: 'Add your brand kit', text: 'Logo, colors, and a call to action for intros and outros.', action: '<button type="button" class="button button-ghost small" data-open-brand>Open brand kit</button>' }
  ];
  const remaining = steps.filter(step => !step.done).length;
  box.classList.toggle('hidden', hidden || !remaining || !canEdit());
  if (hidden || !remaining) return;
  box.innerHTML = `<div class="onboarding-head"><div><div class="eyebrow">GETTING STARTED</div><h2 id="onboardingTitle">${steps.length - remaining} of ${steps.length} done</h2></div><div class="onboarding-links"><button type="button" class="link-button" data-onboard="examples">See what you'll receive</button><button type="button" class="link-button" data-onboard="hide">Hide checklist</button></div></div><ol class="checklist">${steps.map(step => `<li class="${step.done ? 'done' : ''}"><span class="check" aria-hidden="true">${step.done ? '✓' : ''}</span><div><strong>${step.title}</strong><p>${step.text}</p></div><div class="checklist-action">${step.done ? '<span class="hint">Done</span>' : step.action}</div></li>`).join('')}</ol>`;
}

function renderRecent() {
  const recent = libraryItems().sort((a, b) => String(b.item.createdAt).localeCompare(String(a.item.createdAt))).slice(0, 3);
  $('#recentItems').innerHTML = recent.length ? recent.map(({ kind, item }) => `<a class="card" href="${kind === 'podcast' ? `#/studio/${esc(item.id)}` : '#/library'}"><div class="card-top"><span class="tag ${esc(item.status)}">${esc(statusLabel(item.status))}</span><span class="kind-label">${kind === 'podcast' ? 'Podcast' : 'Explainer'}</span></div><h3>${esc(itemTitle(kind, item))}</h3><p>${shortDate(item.createdAt)}</p></a>`).join('') : '<div class="empty"><strong>Nothing yet</strong>Your first podcast or explainer will appear here.</div>';
  $('#recentPersonas').innerHTML = state.personas.length ? state.personas.slice(0, 6).map(p => `<a class="persona-chip" href="#/personas">${avatar(p)}${esc(p.name)}</a>`).join('') : '<div class="empty">Your cast starts with a persona.</div>';
}

export function renderCredits() {
  const account = state.account;
  if (!account) return;
  const low = account.credits < 30;
  $('#creditCount').textContent = account.credits;
  $('#creditLow').classList.toggle('hidden', !low);
  $('#creditReadout').classList.toggle('low', low);
  const banner = $('#creditBanner');
  const owner = state.me?.role === 'owner';
  banner.classList.toggle('hidden', !low);
  banner.innerHTML = low ? `<span><strong>${account.credits} credits left.</strong> ${account.credits < 20 ? 'Not enough for a podcast.' : 'Enough for about one more run.'}</span>${owner ? '<a class="button button-ink small" href="#/billing">Top up credits</a>' : '<span class="hint">Ask the workspace owner to top up.</span>'}` : '';
}

export async function renderDashboard() {
  renderRecent();
  renderCredits();
  const brand = await api('/api/brand').catch(() => ({}));
  renderOnboarding(Boolean(brand?.name || brand?.logo));
}

async function createSampleCast(button) {
  await busy(button, async () => {
    try {
      const templates = state.templates || (state.templates = await api('/api/persona-templates'));
      for (const id of ['interviewer', 'founder']) {
        const template = templates.find(entry => entry.id === id);
        if (template) await api('/api/personas', { method: 'POST', body: JSON.stringify({ name: template.name, systemPrompt: template.systemPrompt, voice: template.voice, voiceStyle: template.voiceStyle, speechProvider: 'gateway', modelProvider: 'gateway' }) });
      }
      await refreshData();
      notice('Created Maya (host) and Daniel (guest). Edit them any time.', true);
    } catch (error) { notice(error.message); }
  }, 'Creating…');
}

export function initDashboard() {
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-onboard]');
    if (!button) return;
    if (button.dataset.onboard === 'sample-cast') createSampleCast(button);
    if (button.dataset.onboard === 'hide') { try { localStorage.setItem(CHECKLIST_KEY, '1'); } catch {} $('#onboarding').classList.add('hidden'); }
    if (button.dataset.onboard === 'examples') showExamples();
  });
}

function showExamples() {
  const source = document.querySelector('#examples .deliverables');
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog dialog-wide';
  dialog.setAttribute('aria-label', 'What you receive');
  dialog.innerHTML = `<form method="dialog"><div class="dialog-head"><div><div class="eyebrow">EXAMPLE OUTPUTS</div><h2>What every run gives you</h2></div><button class="icon-button" aria-label="Close">×</button></div><div class="dialog-scroll">${source ? source.outerHTML : ''}</div></form>`;
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
