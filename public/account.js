import { $, esc, state, api, notice, busy, shortDate, money, confirmDialog, skeleton, refreshMe } from './core.js';

// Billing & usage, Team, and Settings screens, plus plan cards shared with the public pages.
const KIND_LABELS = { subscription_cycle: 'Monthly plan credits', topup: 'Credit top-up', podcast: 'Podcast', explainer: 'Explainer', test: 'Adjustment' };
function ledgerLabel(row) {
  const refund = String(row.kind).startsWith('refund:');
  const kind = refund ? row.kind.slice(7) : row.kind;
  const base = KIND_LABELS[kind] || kind;
  const ref = String(row.referenceId || '');
  const detail = /render-/.test(ref) ? 'video render' : /rerender/.test(ref) ? 're-render' : /shorts/.test(ref) ? 'shorts' : /dub-/.test(ref) ? 'dub' : /translate-/.test(ref) ? 'translation' : /attempt-/.test(ref) ? 'resume' : '';
  return `${refund ? 'Refund — ' : ''}${base}${detail ? ` (${detail})` : ''}`;
}

export function planMarkup(context = 'public') {
  const plans = state.config?.plans || [];
  return plans.map((plan, index) => `<article class="price-row ${plan.id === 'pro' ? 'recommended' : ''}"><div class="plan-index">${String(index + 1).padStart(2, '0')}</div><div class="plan-copy"><h3>${esc(plan.name)}</h3><p>${plan.credits} credits each paid month</p></div><div class="plan-price"><strong>$${plan.monthly}</strong><span>/ month</span></div><div class="plan-output"><span>${Math.floor(plan.credits / 20)} podcast equivalents</span><span>${Math.floor(plan.credits / 30)} explainer equivalents</span></div>${context === 'workspace' && state.account?.plan === plan.id ? '<span class="current-plan">Current plan</span>' : `<button class="button ${plan.id === 'pro' ? 'button-signal' : 'button-ink'}" data-plan="${plan.id}" data-context="${context}">${context === 'public' ? 'Subscribe to' : context === 'workspace' ? 'Change to' : 'Choose'} ${esc(plan.name)}</button>`}</article>`).join('');
}
export function renderPlans() {
  $('#publicPlans').innerHTML = planMarkup('public');
  $('#gatePlans').innerHTML = planMarkup('gate');
  $('#workspacePlans').innerHTML = state.me?.role === 'owner' ? planMarkup('workspace') : '';
}

export async function renderBilling() {
  const a = state.account;
  if (a) {
    $('#billingCredits').textContent = a.credits;
    $('#billingPlan').textContent = (a.plan || 'none').toUpperCase();
    $('#billingStatus').textContent = (a.subscriptionStatus || 'none').replace('_', ' ').toUpperCase();
    $('#billingRenewal').textContent = a.periodEnd ? shortDate(a.periodEnd) : '—';
  }
  const owner = state.me?.role === 'owner';
  $('#manageBilling').classList.toggle('hidden', !owner);
  $('#topUps').innerHTML = skeleton(1); $('#creditLedger').innerHTML = `<tr><td colspan="3">${skeleton(2)}</td></tr>`; $('#usageSummary').innerHTML = skeleton(1);
  const [credits, usage] = await Promise.all([api('/api/credits').catch(() => null), api('/api/usage?days=30').catch(() => null)]);
  state.credits = credits;
  $('#topUps').innerHTML = !credits ? '' : owner ? credits.topUps.map(pack => `<article class="topup"><strong>${pack.credits}</strong><span>credits</span><em>$${pack.price}</em><small>≈ ${Math.floor(pack.credits / 20)} podcasts or ${Math.floor(pack.credits / 30)} explainers</small><button type="button" class="button button-ink small" data-topup="${esc(pack.id)}">Buy ${esc(pack.name)}</button></article>`).join('') : '<p class="hint">Only the workspace owner can buy credits.</p>';
  $('#creditLedger').innerHTML = credits?.ledger?.length ? credits.ledger.map(row => `<tr><td>${shortDate(row.createdAt)}</td><td>${esc(ledgerLabel(row))}</td><td class="num ${row.amount < 0 ? 'minus' : 'plus'}">${row.amount > 0 ? '+' : ''}${row.amount}</td></tr>`).join('') : '<tr><td colspan="3" class="hint">No credit activity yet.</td></tr>';
  if (usage) {
    const kinds = Object.entries(usage.byKind || {}).filter(([kind]) => ['podcast', 'explainer'].includes(kind));
    $('#usageSummary').innerHTML = `<div class="stat-tiles"><div class="stat-tile"><small>Estimated AI cost</small><strong>${money(usage.total.costUsd)}</strong><span>${usage.total.calls} model and voice calls</span></div>${kinds.map(([kind, entry]) => `<div class="stat-tile"><small>${kind === 'podcast' ? 'Podcasts' : 'Explainers'}</small><strong>${money(entry.costUsd)}</strong><span>${entry.runs} runs · ${money(entry.runs ? entry.costUsd / entry.runs : 0)} per run</span></div>`).join('')}</div><details class="model-config"><summary>Which models are used</summary><table class="ledger-table"><thead><tr><th scope="col">Step</th><th scope="col">Model</th></tr></thead><tbody>${Object.values(usage.models || {}).map(entry => `<tr><td>${esc(entry.description)}</td><td><code>${esc(entry.model)}</code>${entry.overridden ? ' <span class="hint">(custom)</span>' : ''}</td></tr>`).join('')}</tbody></table></details>`;
  } else $('#usageSummary').innerHTML = '<p class="hint">Usage is unavailable right now.</p>';
  renderPlans();
}

// --- Team -------------------------------------------------------------------------------------
export async function renderTeam() {
  const panel = $('#teamPanel');
  panel.innerHTML = skeleton(2, 'skeleton-card');
  let data;
  try { data = await api('/api/team'); } catch (error) { panel.innerHTML = `<p class="row-error">${esc(error.message)}</p>`; return; }
  const manage = ['owner', 'admin'].includes(data.role);
  const roleSelect = (member) => `<select data-member-role="${esc(member.userId)}" aria-label="Role for ${esc(member.email || member.userId)}" ${manage && (member.role !== 'admin' || data.role === 'owner') ? '' : 'disabled'}>${['admin', 'editor', 'viewer'].map(role => `<option value="${role}" ${member.role === role ? 'selected' : ''} ${role === 'admin' && data.role !== 'owner' ? 'disabled' : ''}>${role[0].toUpperCase() + role.slice(1)}</option>`).join('')}</select>`;
  const members = data.members.map(member => `<tr><td>${esc(member.email || member.userId)}${member.userId === data.actorId ? ' <span class="hint">(you)</span>' : ''}</td><td>${roleSelect(member)}</td><td>${shortDate(member.joinedAt)}</td><td class="num">${manage && (member.role !== 'admin' || data.role === 'owner') ? `<button type="button" class="danger-link" data-remove-member="${esc(member.userId)}">Remove</button>` : ''}</td></tr>`).join('');
  panel.innerHTML = `
    <section class="settings-card"><h2>${esc(data.team?.name || 'Your workspace')}</h2><p class="hint">You are ${data.role === 'owner' ? 'the owner' : `a${data.role === 'admin' ? 'n' : ''} ${data.role}`} of this workspace.</p>
      ${data.role === 'owner' ? `<form id="teamNameForm" class="inline-form"><label>Team name<input name="name" maxlength="80" value="${esc(data.team?.name || '')}" placeholder="Acme marketing"></label><button class="button button-ghost small">Save</button></form>` : '<button type="button" class="button button-ghost small" id="leaveTeam">Leave this workspace</button>'}
      <dl class="role-guide"><dt>Admin</dt><dd>Everything except billing; can invite and manage members.</dd><dt>Editor</dt><dd>Creates personas, podcasts, and explainers; spends credits.</dd><dt>Viewer</dt><dd>Watches, downloads, and reads; cannot create or spend.</dd></dl></section>
    <section class="settings-card"><h2>Members</h2><div class="table-wrap"><table class="ledger-table"><thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Joined</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead><tbody><tr><td>Workspace owner</td><td>Owner</td><td>—</td><td></td></tr>${members}</tbody></table></div></section>
    ${manage ? `<section class="settings-card"><h2>Invite someone</h2><form id="inviteForm" class="inline-form"><label>Email<input name="email" type="email" required placeholder="colleague@company.com"></label><label>Role<select name="role"><option value="editor">Editor</option><option value="viewer">Viewer</option>${data.role === 'owner' ? '<option value="admin">Admin</option>' : ''}</select></label><button class="button button-primary small">Send invite</button></form><p class="hint">${data.emailInvites ? 'We email the invitation link.' : 'Copy the invitation link and send it yourself.'} Links expire after 7 days and only work for that email address.</p><div id="inviteResult" aria-live="polite"></div>
      ${data.invites.length ? `<h3>Pending invitations</h3><ul class="publish-list">${data.invites.map(invite => `<li>${esc(invite.email)} · ${esc(invite.role)} · expires ${shortDate(invite.expiresAt)} <button type="button" class="danger-link" data-cancel-invite="${esc(invite.token)}">Cancel</button></li>`).join('')}</ul>` : ''}</section>` : ''}`;
}

async function teamAction(event) {
  const remove = event.target.closest('[data-remove-member]'), cancel = event.target.closest('[data-cancel-invite]');
  if (remove) {
    if (!await confirmDialog({ title: 'Remove this member?', message: 'They immediately lose access to this workspace.', confirm: 'Remove', danger: true })) return;
    try { await api(`/api/team/members/${remove.dataset.removeMember}`, { method: 'DELETE' }); notice('Member removed.', true); renderTeam(); } catch (error) { notice(error.message); }
  }
  if (cancel) { try { await api(`/api/team/invites/${cancel.dataset.cancelInvite}`, { method: 'DELETE' }); renderTeam(); } catch (error) { notice(error.message); } }
  if (event.target.id === 'leaveTeam') {
    if (!await confirmDialog({ title: 'Leave this workspace?', message: 'You lose access to its library, personas, and credits.', confirm: 'Leave', danger: true })) return;
    try { await api('/api/team/leave', { method: 'POST' }); location.reload(); } catch (error) { notice(error.message); }
  }
}

// --- Settings ---------------------------------------------------------------------------------
export async function renderSettings() {
  const panel = $('#settingsPanel');
  panel.innerHTML = skeleton(3, 'skeleton-card');
  const [settings, integrations, feed] = await Promise.all([api('/api/settings').catch(() => ({})), api('/api/integrations').catch(() => ({})), api('/api/feed').catch(() => ({}))]);
  const manage = ['owner', 'admin'].includes(state.me?.role);
  const yt = integrations.youtube || {};
  const theme = document.documentElement.dataset.theme;
  panel.innerHTML = `
    <section class="settings-card"><h2>Notifications</h2><label class="check-inline"><input type="checkbox" data-setting="notifyEmail" ${settings.notifyEmail !== false ? 'checked' : ''} ${manage ? '' : 'disabled'}> Email the owner when a video, explainer, or set of shorts is ready</label>${settings.emailConfigured ? '' : '<p class="hint">Email delivery is not configured on this deployment yet.</p>'}<label class="check-inline"><input type="checkbox" id="browserNotify" ${'Notification' in window && Notification.permission === 'granted' ? 'checked' : ''}> Show a browser notification when a run I started finishes</label></section>
    <section class="settings-card"><h2>Keep media for</h2><p class="hint">Older episodes and explainers are deleted automatically with their files. Episodes in your podcast feed are kept.</p><label>Retention<select data-setting="retentionDays" ${manage ? '' : 'disabled'}>${[[0, 'Keep everything'], [30, '30 days'], [60, '60 days'], [90, '90 days'], [180, '180 days'], [365, '1 year']].map(([value, label]) => `<option value="${value}" ${Number(settings.retentionDays || 0) === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></section>
    <section class="settings-card"><h2>YouTube</h2>${!yt.configured ? '<p class="hint">YouTube publishing is not configured on this deployment.</p>' : yt.connected ? `<p>Connected${yt.channel?.title ? ` to <strong>${esc(yt.channel.title)}</strong>` : ''}. Videos upload as private by default.</p>${manage ? '<button type="button" class="button button-ghost small" id="disconnectYoutube">Disconnect</button>' : ''}` : `<p class="hint">Connect a channel to upload finished videos with their title, description, chapters, and thumbnail.</p>${manage ? '<button type="button" class="button button-primary small" id="connectYoutube">Connect YouTube</button>' : ''}`}</section>
    <section class="settings-card"><h2>Podcast feed</h2>${feed.token ? `<form id="feedForm" class="stack-form"><label>Show title<input name="title" maxlength="120" value="${esc(feed.title || '')}"></label><label>Author<input name="author" maxlength="120" value="${esc(feed.author || '')}"></label><label>Description<textarea name="description" rows="2" maxlength="2000">${esc(feed.description || '')}</textarea></label><label>Feed URL<input readonly value="${esc(feed.url)}" onclick="this.select()"></label><div class="publish-actions"><button class="button button-ghost small">Save</button><button type="button" class="link-button" id="rotateFeed">Reset the feed link</button></div></form><p class="hint">Add episodes to the feed from each episode's Publish dialog.</p>` : `<p class="hint">Publish podcast audio to Apple Podcasts, Spotify, and other apps with a private RSS feed.</p><button type="button" class="button button-ghost small" id="createFeed">Create podcast feed</button>`}</section>
    <section class="settings-card"><h2>Brand kit</h2><p class="hint">Logo, colors, and a call to action for intro and outro cards and thumbnails.</p><button type="button" class="button button-ghost small" data-open-brand>Open brand kit</button></section>
    <section class="settings-card"><h2>Appearance</h2><div class="segmented" role="radiogroup" aria-label="Theme">${['light', 'dark'].map(value => `<button type="button" role="radio" aria-checked="${theme === value}" data-theme-choice="${value}">${value === 'light' ? 'Light' : 'Dark'}</button>`).join('')}</div></section>`;
}

async function settingsAction(event) {
  const target = event.target;
  if (target.id === 'connectYoutube') busy(target, async () => { try { const { url } = await api('/api/integrations/youtube/connect', { method: 'POST' }); location.assign(url); } catch (error) { notice(error.message); } });
  if (target.id === 'disconnectYoutube') { if (await confirmDialog({ title: 'Disconnect YouTube?', message: 'Uploads stop until you connect again. Videos already uploaded stay on YouTube.', confirm: 'Disconnect', danger: true })) { await api('/api/integrations/youtube', { method: 'DELETE' }).catch(error => notice(error.message)); renderSettings(); } }
  if (target.id === 'createFeed') busy(target, async () => { try { await api('/api/feed', { method: 'PUT', body: JSON.stringify({ title: 'My podcast' }) }); renderSettings(); } catch (error) { notice(error.message); } });
  if (target.id === 'rotateFeed') { if (await confirmDialog({ title: 'Reset the feed link?', message: 'The old link stops working. Update it wherever you submitted the feed.', confirm: 'Reset link', danger: true })) { await api('/api/feed', { method: 'PUT', body: JSON.stringify({ rotate: true }) }).catch(error => notice(error.message)); renderSettings(); } }
  const themeChoice = target.closest('[data-theme-choice]');
  if (themeChoice) { document.dispatchEvent(new CustomEvent('theme:set', { detail: themeChoice.dataset.themeChoice })); renderSettings(); }
}

async function settingsChange(event) {
  const setting = event.target.dataset.setting;
  if (setting) {
    const value = event.target.type === 'checkbox' ? event.target.checked : Number(event.target.value);
    try { await api('/api/settings', { method: 'PUT', body: JSON.stringify({ [setting]: value }) }); notice('Saved.', true); } catch (error) { notice(error.message); }
  }
  if (event.target.id === 'browserNotify' && event.target.checked && 'Notification' in window) {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { event.target.checked = false; notice('Notifications are blocked for this site in your browser settings.'); }
  }
}

export function initAccount() {
  document.addEventListener('click', event => {
    const topup = event.target.closest('[data-topup]');
    if (topup) busy(topup, async () => { try { const { url } = await api('/api/billing/topup', { method: 'POST', body: JSON.stringify({ pack: topup.dataset.topup }) }); location.assign(url); } catch (error) { notice(error.message); } }, 'Opening checkout…');
    if (event.target.closest('#teamPanel')) teamAction(event);
    if (event.target.closest('#settingsPanel')) settingsAction(event);
  });
  document.addEventListener('change', event => {
    const role = event.target.closest('[data-member-role]');
    if (role) api(`/api/team/members/${role.dataset.memberRole}`, { method: 'PATCH', body: JSON.stringify({ role: role.value }) }).then(() => notice('Role updated.', true), error => { notice(error.message); renderTeam(); });
    if (event.target.closest('#settingsPanel')) settingsChange(event);
  });
  document.addEventListener('submit', async event => {
    const form = event.target;
    if (form.id === 'inviteForm') {
      event.preventDefault();
      await busy(form.querySelector('button'), async () => {
        try {
          const result = await api('/api/team/invites', { method: 'POST', body: JSON.stringify({ email: form.elements.email.value, role: form.elements.role.value }) });
          $('#inviteResult').innerHTML = `<p class="publish-ok">${result.emailed ? 'Invitation emailed.' : 'Invitation created. Send this link:'}</p><input readonly value="${esc(result.link)}" onclick="this.select()" aria-label="Invitation link">`;
          form.reset(); setTimeout(renderTeam, 1500);
        } catch (error) { notice(error.message); }
      });
    }
    if (form.id === 'teamNameForm') { event.preventDefault(); try { await api('/api/team', { method: 'PUT', body: JSON.stringify({ name: form.elements.name.value }) }); notice('Team renamed.', true); await refreshMe(); } catch (error) { notice(error.message); } }
    if (form.id === 'feedForm') { event.preventDefault(); try { await api('/api/feed', { method: 'PUT', body: JSON.stringify({ title: form.elements.title.value, author: form.elements.author.value, description: form.elements.description.value }) }); notice('Feed saved.', true); } catch (error) { notice(error.message); } }
  });
  document.addEventListener('brand:saved', () => { if (!$('#view-settings').classList.contains('hidden')) renderSettings(); });
}
