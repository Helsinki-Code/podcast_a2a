import { friendlyError } from './errors.js';

// Shared browser state and helpers for every studio module.
export const $ = selector => document.querySelector(selector);
export const $$ = selector => [...document.querySelectorAll(selector)];
export const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const state = {
  personas: [], episodes: [], explainers: [], config: null, account: null, me: null, clerk: null, stats: null, credits: null,
  current: null, templates: null, awaitingPlan: new Set(), credentials: new Map(), listeners: new Map()
};

// Tiny pub/sub so modules can react to data refreshes without importing each other.
export function on(event, fn) { if (!state.listeners.has(event)) state.listeners.set(event, new Set()); state.listeners.get(event).add(fn); }
export function emit(event, payload) { for (const fn of state.listeners.get(event) || []) fn(payload); }

export async function authHeaders() {
  const token = await state.clerk?.session?.getToken().catch(() => null);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...await authHeaders(), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
  return data;
}

export async function uploadFile(file, kind) {
  const response = await fetch(`/api/uploads?kind=${kind}&name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', ...await authHeaders() }, body: file });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Could not upload ${file.name}`);
  return data;
}

// Toast stack: success toasts auto-dismiss, errors stay until closed. Announced to screen readers.
export function notice(message, good = false, { action } = {}) {
  const stack = $('#toasts');
  if (!stack) return;
  const toast = document.createElement('div');
  toast.className = `toast ${good ? 'ok' : 'error'}`;
  toast.setAttribute('role', good ? 'status' : 'alert');
  toast.innerHTML = `<p>${esc(message)}</p>${action ? `<button type="button" class="toast-action">${esc(action.label)}</button>` : ''}<button type="button" class="toast-close" aria-label="Dismiss">×</button>`;
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
  if (action) toast.querySelector('.toast-action').addEventListener('click', () => { toast.remove(); action.run(); });
  stack.prepend(toast);
  while (stack.children.length > 4) stack.lastElementChild.remove();
  if (good) setTimeout(() => toast.remove(), 6000);
}

// Runs an async action with a disabled, spinner-marked button so double clicks can't double-charge.
export async function busy(button, run, label = '') {
  if (!button) return run();
  const original = button.innerHTML;
  button.disabled = true; button.setAttribute('aria-busy', 'true'); button.classList.add('is-busy');
  if (label) button.textContent = label;
  try { return await run(); }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); button.classList.remove('is-busy'); if (label) button.innerHTML = original; }
}

export function errorMarkup(message, className = 'row-error') {
  const info = friendlyError(message);
  return info ? `<small class="${className}" title="${esc(info.detail)}"><strong>${esc(info.title)}.</strong> ${esc(info.hint)}</small>` : '';
}

export const shortDate = date => date ? new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
export const clock = seconds => { const total = Math.max(0, Math.floor(Number(seconds) || 0)); const h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; };
export const money = value => { const amount = Number(value) || 0; return `$${amount.toFixed(amount > 0 && amount < 1 ? 3 : 2)}`; };
export const itemTitle = (kind, item) => kind === 'podcast' ? (item.title || item.outline?.subject || 'Untitled podcast') : (item.title || 'Untitled explainer');
export const person = id => state.personas.find(p => p.id === id);
export const episodePerson = (episode, role) => episode?.personas?.[role] || person(episode?.[`${role}Id`]);
export const avatar = (p, big = false) => p?.image ? `<img class="${big ? 'avatar-lg' : 'avatar'}" src="${esc(p.image)}" alt="">` : `<span class="${big ? 'avatar-lg' : 'avatar'}" aria-hidden="true">${esc((p?.name || '?')[0].toUpperCase())}</span>`;
export const canEdit = () => !['viewer'].includes(state.me?.role);

const STATUS_LABELS = { draft: 'Draft', preparing: 'Starting', running: 'Recording', complete: 'Ready', stopped: 'Stopped', failed: 'Failed', interrupted: 'Interrupted', queued: 'Queued', planning: 'Planning', awaiting_approval: 'Review plan', rendering: 'Re-rendering' };
export const statusLabel = status => STATUS_LABELS[status] || String(status || '').replace(/_/g, ' ');

// Accessible replacements for window.confirm / window.prompt, built on <dialog>.
export function confirmDialog({ title, message, confirm = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    const dialog = $('#confirmDialog');
    dialog.querySelector('h2').textContent = title;
    dialog.querySelector('.confirm-message').textContent = message;
    const button = dialog.querySelector('[data-confirm]');
    button.textContent = confirm;
    button.className = `button ${danger ? 'button-danger' : 'button-primary'}`;
    const input = dialog.querySelector('input');
    input.classList.add('hidden');
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
    button.focus();
  });
}

export function promptDialog({ title, label, value = '', confirm = 'Save' }) {
  return new Promise(resolve => {
    const dialog = $('#confirmDialog');
    dialog.querySelector('h2').textContent = title;
    dialog.querySelector('.confirm-message').textContent = label;
    const input = dialog.querySelector('input');
    input.classList.remove('hidden');
    input.value = value;
    input.setAttribute('aria-label', label);
    const button = dialog.querySelector('[data-confirm]');
    button.textContent = confirm; button.className = 'button button-primary';
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm' ? input.value.trim() : null), { once: true });
    dialog.showModal();
    input.focus(); input.select();
  });
}

// Loading placeholders while lists fetch.
export const skeleton = (rows = 3, className = 'skeleton-row') => Array.from({ length: rows }, () => `<div class="${className}" aria-hidden="true"><span></span><span></span></div>`).join('');

export async function refreshMe() {
  const me = await api('/api/auth/me');
  state.me = me; state.account = me.account;
  emit('account', me);
  return me;
}

export async function refreshData() {
  const [personas, episodes, explainers] = await Promise.all([api('/api/personas'), api('/api/episodes'), api('/api/explainers')]);
  Object.assign(state, { personas, episodes, explainers });
  emit('data');
}
