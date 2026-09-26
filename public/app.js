import { $, $$, state, api, notice, on, refreshMe, refreshData, esc } from './core.js';
import { initStudio, openStudio, leaveStudio } from './studio.js';
import { initWizard, openEpisodeWizard } from './wizard.js';
import { initLibrary, renderLibrary, setLibraryType } from './library.js';
import { initDashboard, renderDashboard, renderCredits, loadStats } from './dashboard.js';
import { initPersonas, renderPersonas } from './personas.js';
import { initExplainers, openExplainerDialog, schedulePoll } from './explainers.js';
import { initAccount, renderBilling, renderTeam, renderSettings, renderPlans } from './account.js';

// Entry point: sign-in and paywall, hash routing, and wiring between the studio modules.
const VIEWS = { dashboard: 'OVERVIEW', library: 'LIBRARY', personas: 'PERSONAS', billing: 'BILLING & USAGE', team: 'TEAM', settings: 'SETTINGS', studio: 'STUDIO' };

function parseRoute() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [view, id] = path.split('/');
  return { view: VIEWS[view] ? view : 'dashboard', id, params: new URLSearchParams(query) };
}

async function route() {
  if ($('#workspace').classList.contains('hidden')) return;
  const { view, id, params } = parseRoute();
  if (view !== 'studio') leaveStudio();
  $$('.view').forEach(section => section.classList.add('hidden'));
  $(`#view-${view}`).classList.remove('hidden');
  $$('.nav').forEach(link => { const active = link.dataset.view === (view === 'studio' ? 'library' : view); link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  $('#crumb').textContent = VIEWS[view];
  document.title = `${view === 'dashboard' ? 'Overview' : VIEWS[view][0] + VIEWS[view].slice(1).toLowerCase()} — The Sales Forge`;
  window.scrollTo(0, 0);
  try {
    if (view === 'dashboard') { renderDashboard(); loadStats(); }
    if (view === 'library') setLibraryType(params.get('type') || 'all');
    if (view === 'personas') renderPersonas();
    if (view === 'billing') await renderBilling();
    if (view === 'team') await renderTeam();
    if (view === 'settings') await renderSettings();
    if (view === 'studio' && id) await openStudio(id);
  } catch (error) { notice(error.status === 404 ? 'That item no longer exists.' : error.message); if (view === 'studio') location.hash = '#/library'; }
  // Move focus to the page heading so keyboard and screen-reader users land in the new view.
  const heading = $(`#view-${view} h1`);
  if (heading && document.activeElement?.closest('.nav, .sidebar, .topbar')) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
}

function renderChrome() {
  const me = state.me;
  const readOnly = me?.role === 'viewer';
  $$('[data-new]').forEach(button => button.classList.toggle('hidden', readOnly));
  $('#roleBadge').classList.toggle('hidden', !me || me.role === 'owner');
  $('#roleBadge').textContent = me?.role ? `${me.role}${me.teamName ? ` · ${me.teamName}` : ''}` : '';
  $('#workspaceName').textContent = me?.teamName ? me.teamName.toUpperCase() : 'PRODUCT MEDIA DESK';
  $('#modelDot').classList.toggle('ready', Boolean(state.config?.ready.model)); $('#sandboxDot').classList.toggle('ready', Boolean(state.config?.ready.sandbox));
  $('#modelState').textContent = state.config?.ready.model ? 'Model connected' : 'Model key needed';
  $('#sandboxState').textContent = state.config?.ready.sandbox ? 'Sandbox connected' : 'Sandbox key needed';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#171a1c' : '#f2f1ec');
  try { localStorage.setItem('sales-forge-theme', theme); } catch {}
}

async function checkout(plan) {
  if (!state.clerk?.user) { state.clerk?.openSignIn({ redirectUrl: window.location.href }); return; }
  const result = await api('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ plan }) });
  window.location.assign(result.url);
}
async function openPortal() { window.location.assign((await api('/api/billing/portal', { method: 'POST' })).url); }

async function acceptInvite(token) {
  try {
    const result = await api('/api/team/accept', { method: 'POST', body: JSON.stringify({ token }) });
    history.replaceState({}, '', '/');
    notice(`You joined ${result.team?.name || 'the workspace'} as ${result.role}.`, true);
    return true;
  } catch (error) { history.replaceState({}, '', '/'); notice(error.message); return false; }
}

async function bootstrap() {
  const config = await (await fetch('/api/config')).json();
  state.config = config;
  renderPlans();
  if (config.demoVideoUrl) $('#demoVideoSlot').innerHTML = `<video controls preload="metadata" playsinline src="${esc(config.demoVideoUrl)}"></video>`;
  if (!config.clerkPublishableKey) throw new Error('Clerk is not configured.');
  state.clerk = await window.createSalesForgeClerk(config.clerkPublishableKey);
  const initialUser = state.clerk.user?.id || null;
  state.clerk.addListener(({ user }) => { if ((user?.id || null) !== initialUser) window.location.reload(); });
  const query = new URLSearchParams(location.search);
  if (!state.clerk.user) {
    if (query.get('invite')) { $('#signInButton').textContent = 'Sign in to accept your invitation'; state.clerk.openSignIn({ redirectUrl: window.location.href }); }
    return;
  }
  if (query.get('invite')) await acceptInvite(query.get('invite'));
  let me = await refreshMe();
  if (query.get('billing') === 'success' && !['active', 'trialing'].includes(me.account.subscriptionStatus)) {
    for (let i = 0; i < 12 && !['active', 'trialing'].includes(me.account.subscriptionStatus); i++) { await new Promise(resolve => setTimeout(resolve, 1500)); me = await refreshMe(); }
  }
  $('#publicGate').classList.add('hidden');
  if (!['active', 'trialing'].includes(me.account.subscriptionStatus)) { $('#subscriptionGate').classList.remove('hidden'); return; }
  $('#subscriptionGate').classList.add('hidden'); $('#workspace').classList.remove('hidden');
  state.clerk.mountUserButton($('#clerkUserButton'), { appearance: { elements: { avatarBox: { width: '32px', height: '32px' } } } });
  renderChrome(); renderCredits();
  await refreshData();
  state.loaded = true;
  renderPlans();
  await route();
  schedulePoll();
  const billing = query.get('billing'), youtube = query.get('youtube');
  if (billing || youtube) history.replaceState({}, '', `/${location.hash}`);
  if (billing === 'success') notice('Payment confirmed. Monthly credits are ready.', true);
  if (billing === 'topup') notice('Thanks! Your credits are added as soon as the payment clears.', true);
  if (youtube) notice(youtube === 'connected' ? 'YouTube connected. Open Publish on any finished video to upload it.' : 'YouTube was not connected. Please try again.', youtube === 'connected');
}

function init() {
  applyTheme((() => { try { return localStorage.getItem('sales-forge-theme'); } catch { return null; } })() || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  initStudio(); initWizard(); initLibrary(); initDashboard(); initPersonas(); initExplainers(); initAccount();
  on('data', () => { renderLibrary(); renderPersonas(); if (!$('#view-dashboard').classList.contains('hidden')) renderDashboard(); });
  on('account', () => { renderChrome(); renderCredits(); });
  window.addEventListener('hashchange', route);
  $$('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  document.addEventListener('click', event => {
    const create = event.target.closest('[data-new]');
    if (create) {
      if (create.dataset.new === 'podcast') {
        if (state.personas.length < 2) notice('You need a host and a guest first — the wizard can create them for you.', true);
        openEpisodeWizard();
      } else openExplainerDialog();
    }
    const plan = event.target.closest('[data-plan]');
    if (plan) (plan.dataset.context === 'workspace' ? openPortal() : checkout(plan.dataset.plan)).catch(error => notice(error.message));
    if (event.target.closest('[data-theme-toggle]')) applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  document.addEventListener('theme:set', event => applyTheme(event.detail));
  document.addEventListener('podcast:restart', event => { location.hash = `#/studio/${event.detail.id}`; setTimeout(() => $('#restartEpisode').click(), 600); });
  $('#manageBilling').addEventListener('click', () => openPortal().catch(error => notice(error.message)));
  $('#signInButton').addEventListener('click', () => state.clerk?.openSignIn({ redirectUrl: window.location.href }));
  $('#choosePlanButton').addEventListener('click', () => $('#pricing').scrollIntoView({ behavior: 'smooth' }));
  $('#watchWorkflowButton').addEventListener('click', () => $('#examples').scrollIntoView({ behavior: 'smooth' }));
  $('#gateSignOut').addEventListener('click', () => state.clerk?.signOut({ redirectUrl: '/' }));
  $('#themeToggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  bootstrap().catch(error => notice(error.message));
}

init();
