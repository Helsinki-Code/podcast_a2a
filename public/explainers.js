import { $, esc, state, api, notice, busy, uploadFile, refreshData, refreshMe, confirmDialog } from './core.js';
import { testLogin } from './wizard.js';

// Explainer creation (with optional sign-in), scene-plan review, re-render, restart, brand kit.
let pollTimer = null;

export function openExplainerDialog(item = null) {
  const form = $('#explainerForm'); form.reset(); form.dataset.explainerId = item?.id || '';
  if (item) {
    for (const name of ['title', 'url', 'brief', 'voice', 'captionStyle', 'loginUrl', 'usernameSelector', 'passwordSelector', 'submitSelector']) if (form.elements[name] && item[name] != null) form.elements[name].value = item[name];
    form.elements.authRequired.checked = !!item.authRequired;
    const captions = item.captionOptions || {};
    form.elements.captionsEnabled.checked = captions.enabled !== false;
    form.elements.captionFont.value = captions.font || 'sans';
    form.elements.captionSize.value = captions.size || 18;
    form.elements.captionTextColor.value = captions.textColor || '#ffffff';
    form.elements.captionBackgroundColor.value = captions.backgroundColor || '#000000';
    form.elements.captionPosition.value = captions.position || 'bottom';
    form.elements.captionWords.value = captions.wordsPerCue || 7;
  }
  $('#explainerCredentials').classList.toggle('hidden', !form.elements.authRequired.checked);
  $('#explainerManualDesktop').classList.add('hidden');
  for (const name of ['username', 'password']) form.elements[name].required = form.elements.authRequired.checked;
  $('#explainerLoginResult').textContent = 'Tries these details in a throwaway browser. Free.';
  updateSubtitlePreview();
  $('#explainerDialog').showModal();
}

function updateSubtitlePreview() {
  const form = $('#explainerForm'), preview = $('#subtitlePreview'), sample = preview.querySelector('span');
  const style = form.elements.captionStyle.value;
  Object.assign(preview.dataset, { style, font: form.elements.captionFont.value, position: form.elements.captionPosition.value });
  sample.style.fontSize = `${form.elements.captionSize.value}px`;
  sample.style.color = form.elements.captionTextColor.value;
  sample.style.backgroundColor = style === 'minimal' || style === 'bold' ? 'transparent' : `${form.elements.captionBackgroundColor.value}bb`;
  sample.style.opacity = form.elements.captionsEnabled.checked ? '1' : '.25';
  $('#captionSizeValue').textContent = `${form.elements.captionSize.value} px`;
  $('#captionWordsValue').textContent = `${form.elements.captionWords.value} words`;
}

async function saveExplainerForm(event) {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('[type=submit]');
  let item = null;
  await busy(button, async () => {
    try {
      const authRequired = form.elements.authRequired.checked;
      if (authRequired && (!form.elements.username.value || !form.elements.password.value)) throw new Error('Enter the sign-in username and password.');
      item = state.explainers.find(entry => entry.id === form.dataset.explainerId) || await api('/api/explainers', { method: 'POST', body: JSON.stringify({
        title: form.elements.title.value, url: form.elements.url.value, brief: form.elements.brief.value, authRequired, voice: form.elements.voice.value, captionStyle: form.elements.captionStyle.value,
        captionOptions: { enabled: form.elements.captionsEnabled.checked, font: form.elements.captionFont.value, size: +form.elements.captionSize.value, textColor: form.elements.captionTextColor.value, backgroundColor: form.elements.captionBackgroundColor.value, position: form.elements.captionPosition.value, wordsPerCue: +form.elements.captionWords.value },
        loginUrl: form.elements.loginUrl.value, usernameSelector: form.elements.usernameSelector.value, passwordSelector: form.elements.passwordSelector.value, submitSelector: form.elements.submitSelector.value,
        reviewPlan: form.elements.reviewPlan.checked, effects: { zoom: form.elements.effectZoom.checked, highlight: form.elements.effectHighlight.checked }, branding: { intro: form.elements.brandIntro.checked, outro: form.elements.brandOutro.checked }
      }) });
      if (authRequired) {
        button.textContent = 'Signing in privately…';
        await api(`/api/explainers/${item.id}/prepare`, { method: 'POST', body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value, loginUrl: form.elements.loginUrl.value, usernameSelector: form.elements.usernameSelector.value, passwordSelector: form.elements.passwordSelector.value, submitSelector: form.elements.submitSelector.value }) });
        form.elements.password.value = '';
      }
      await beginProduction(item, form.elements.reviewPlan.checked, button);
      $('#explainerDialog').close();
    } catch (error) {
      if (item?.id && form.elements.authRequired.checked) { form.dataset.explainerId = item.id; $('#explainerManualDesktop').classList.remove('hidden'); notice(`${error.message} Finish the sign-in in the live desktop.`); }
      else notice(error.message);
    }
  }, 'Working…');
}

// After sign-in: either draft a plan for review (free) or start recording straight away.
async function beginProduction(item, reviewPlan, button = null) {
  if (reviewPlan) {
    if (button) button.textContent = 'Drafting scene plan…';
    await api(`/api/explainers/${item.id}/plan`, { method: 'POST' });
    state.awaitingPlan.add(item.id);
    await refreshData(); location.hash = '#/library?type=explainer'; schedulePoll();
    notice('Drafting a scene plan. You can review and edit it before anything is recorded.', true);
    return;
  }
  if (button) button.textContent = 'Starting…';
  await api(`/api/explainers/${item.id}/start`, { method: 'POST' });
  await refreshMe(); await refreshData(); location.hash = '#/library?type=explainer'; schedulePoll();
  notice('The explainer is in production.', true);
}

export function schedulePoll() {
  clearTimeout(pollTimer);
  const busyItems = state.explainers.filter(item => ['queued', 'running', 'planning', 'rendering'].includes(item.status));
  if (!busyItems.length && !state.episodes.some(item => item.videoStatus === 'processing' || ['running', 'preparing'].includes(item.status))) return;
  const before = new Map(busyItems.map(item => [item.id, item.status]));
  pollTimer = setTimeout(async () => {
    try {
      await refreshData(); schedulePoll();
      for (const item of state.explainers) {
        if (before.get(item.id) && item.status === 'complete') notice(`“${item.title}” is ready.`, true);
        if (before.get(item.id) && item.status === 'failed') notice(`“${item.title}” failed. See the library for details.`);
      }
      const ready = state.explainers.find(item => item.status === 'awaiting_approval' && state.awaitingPlan.has(item.id));
      if (ready && !document.querySelector('dialog[open]')) { state.awaitingPlan.delete(ready.id); openPlanDialog(ready); }
    } catch (error) { notice(error.message); }
  }, 4000);
}

function planSceneMarkup(scene = {}) {
  return `<li class="plan-scene"><div class="form-row"><label>Title<input name="title" maxlength="60" value="${esc(scene.title || '')}"></label><button type="button" class="icon-button" data-remove-scene aria-label="Remove scene">×</button></div><label>What happens<input name="goal" maxlength="240" value="${esc(scene.goal || '')}"></label><label>Narration<textarea name="narration" rows="2" maxlength="360">${esc(scene.narration || scene.text || '')}</textarea></label></li>`;
}
function openPlanDialog(item) {
  const form = $('#planForm'); form.dataset.explainerId = item.id;
  $('#planScenes').innerHTML = (item.plan?.scenes || []).map(planSceneMarkup).join('');
  $('#planDialog').showModal();
}
function readPlanScenes() {
  return [...$('#planScenes').querySelectorAll('.plan-scene')].map(row => ({ title: row.querySelector('[name=title]').value, goal: row.querySelector('[name=goal]').value, narration: row.querySelector('[name=narration]').value }));
}
async function approvePlan(event) {
  event.preventDefault();
  const form = event.currentTarget, id = form.dataset.explainerId;
  await busy(form.querySelector('[type=submit]'), async () => {
    try {
      await api(`/api/explainers/${id}/plan`, { method: 'PUT', body: JSON.stringify({ scenes: readPlanScenes() }) });
      await api(`/api/explainers/${id}/start`, { method: 'POST' });
      $('#planDialog').close(); await refreshMe(); await refreshData(); schedulePoll();
      notice('Plan approved. The explainer is recording.', true);
    } catch (error) { notice(error.message); }
  }, 'Starting…');
}

function openRerenderDialog(item) {
  const form = $('#rerenderForm'); form.dataset.explainerId = item.id;
  form.elements.voice.value = item.voice || 'coral'; form.elements.captionStyle.value = item.captionStyle || 'studio'; form.elements.captionsEnabled.checked = item.captionOptions?.enabled !== false;
  $('#rerenderScenes').innerHTML = item.scenes.map(scene => `<li class="plan-scene"><strong>${esc(scene.title || 'Scene')}</strong><label>Narration<textarea name="text" rows="2" maxlength="400">${esc(scene.text)}</textarea></label></li>`).join('');
  $('#rerenderDialog').showModal();
}
async function submitRerender(event) {
  event.preventDefault();
  const form = event.currentTarget, id = form.dataset.explainerId, item = state.explainers.find(entry => entry.id === id);
  await busy(form.querySelector('[type=submit]'), async () => {
    try {
      const scenes = [...$('#rerenderScenes').querySelectorAll('textarea')].map(area => ({ text: area.value }));
      await api(`/api/explainers/${id}/rerender`, { method: 'POST', body: JSON.stringify({ scenes, voice: form.elements.voice.value, captionStyle: form.elements.captionStyle.value, captionOptions: { ...(item?.captionOptions || {}), enabled: form.elements.captionsEnabled.checked } }) });
      $('#rerenderDialog').close(); await refreshMe(); await refreshData(); schedulePoll();
      notice('Re-rendering with the new narration. The current video stays available until it finishes.', true);
    } catch (error) { notice(error.message); }
  }, 'Starting…');
}

async function restartExplainer(item) {
  if (!await confirmDialog({ title: 'Record this explainer again?', message: `A new take follows the same brief${item.plan?.approved ? ' and approved scene plan' : ''}. It uses 30 credits.`, confirm: 'Record again · 30 credits' })) return;
  try {
    const restarted = await api(`/api/explainers/${item.id}/restart`, { method: 'POST' });
    await refreshData();
    if (restarted.authRequired) { openExplainerDialog(restarted); notice('Enter the sign-in details again to record this explainer.'); return; }
    await api(`/api/explainers/${restarted.id}/start`, { method: 'POST' });
    await refreshMe(); await refreshData(); schedulePoll(); notice('Recording again with the same brief.', true);
  } catch (error) { notice(error.message); }
}

export async function openBrandDialog() {
  const form = $('#brandForm'); form.reset();
  const kit = await api('/api/brand').catch(() => ({}));
  for (const name of ['name', 'outroText', 'callToAction']) form.elements[name].value = kit[name] || '';
  form.elements.primaryColor.value = kit.primaryColor || '#101c24'; form.elements.accentColor.value = kit.accentColor || '#80ded1';
  form._logo = kit.logo || '';
  $('#brandLogoPreview').innerHTML = form._logo ? `<img src="${esc(form._logo)}" alt="Current logo">` : 'No logo';
  $('#brandDialog').showModal();
}
async function saveBrand(event) {
  event.preventDefault();
  const form = event.currentTarget;
  await busy(form.querySelector('[type=submit]'), async () => {
    try {
      const file = form.elements.logoFile.files[0];
      if (file) form._logo = (await uploadFile(file, 'logo')).asset;
      await api('/api/brand', { method: 'PUT', body: JSON.stringify({ name: form.elements.name.value, logo: form._logo, primaryColor: form.elements.primaryColor.value, accentColor: form.elements.accentColor.value, outroText: form.elements.outroText.value, callToAction: form.elements.callToAction.value }) });
      $('#brandDialog').close(); notice('Brand kit saved. New videos will use it.', true);
      document.dispatchEvent(new CustomEvent('brand:saved'));
    } catch (error) { notice(error.message); }
  }, 'Saving…');
}

export function initExplainers() {
  const form = $('#explainerForm');
  form.addEventListener('submit', saveExplainerForm);
  $('#planForm').addEventListener('submit', approvePlan);
  $('#rerenderForm').addEventListener('submit', submitRerender);
  $('#brandForm').addEventListener('submit', saveBrand);
  $('#addPlanScene').addEventListener('click', () => $('#planScenes').insertAdjacentHTML('beforeend', planSceneMarkup()));
  $('#redraftPlan').addEventListener('click', event => busy(event.currentTarget, async () => {
    const id = $('#planForm').dataset.explainerId;
    try { await api(`/api/explainers/${id}/plan`, { method: 'POST' }); state.awaitingPlan.add(id); $('#planDialog').close(); await refreshData(); schedulePoll(); notice('Redrafting the scene plan…', true); }
    catch (error) { notice(error.message); }
  }));
  $('#brandForm').elements.logoFile.addEventListener('change', event => { const file = event.target.files[0]; if (file) $('#brandLogoPreview').innerHTML = `<img src="${URL.createObjectURL(file)}" alt="Logo preview">`; });
  form.elements.authRequired.addEventListener('change', event => { $('#explainerCredentials').classList.toggle('hidden', !event.target.checked); for (const name of ['username', 'password']) form.elements[name].required = event.target.checked; });
  for (const name of ['captionsEnabled', 'captionStyle', 'captionPosition', 'captionFont', 'captionSize', 'captionTextColor', 'captionBackgroundColor', 'captionWords']) form.elements[name].addEventListener('input', updateSubtitlePreview);
  $('#openExplainerDesktop').addEventListener('click', async () => {
    const id = form.dataset.explainerId; if (!id) { notice('Create the explainer first.'); return; }
    const popup = window.open('about:blank', '_blank'); if (popup) popup.opener = null;
    try { const { liveUrl } = await api(`/api/explainers/${id}/desktop`); if (popup) popup.location = liveUrl; else window.open(liveUrl, '_blank', 'noopener'); }
    catch (error) { popup?.close(); notice(error.message); }
  });
  $('#explainerDesktopReady').addEventListener('click', event => busy(event.currentTarget, async () => {
    const id = form.dataset.explainerId; if (!id) { notice('Create the explainer first.'); return; }
    try { await api(`/api/explainers/${id}/desktop-ready`, { method: 'POST' }); form.elements.password.value = ''; await beginProduction({ id }, form.elements.reviewPlan.checked); $('#explainerDialog').close(); }
    catch (error) { notice(error.message); }
  }));
  document.querySelector('[data-login-test="explainer"]').addEventListener('click', event => testLogin(event.currentTarget, { url: form.elements.url, loginUrl: form.elements.loginUrl, username: form.elements.username, password: form.elements.password, usernameSelector: form.elements.usernameSelector, passwordSelector: form.elements.passwordSelector, submitSelector: form.elements.submitSelector }, $('#explainerLoginResult')));
  document.addEventListener('click', event => {
    if (event.target.closest('[data-remove-scene]')) event.target.closest('.plan-scene').remove();
    if (event.target.closest('[data-open-brand]')) openBrandDialog().catch(error => notice(error.message));
  });
  document.addEventListener('explainer:review-plan', event => openPlanDialog(event.detail));
  document.addEventListener('explainer:rerender', event => openRerenderDialog(event.detail));
  document.addEventListener('explainer:retry-signin', event => openExplainerDialog(event.detail));
  document.addEventListener('explainer:open', event => { const item = event.detail; if (item.status === 'awaiting_approval') openPlanDialog(item); else if (item.status === 'draft') openExplainerDialog(item); else notice(item.progress || 'This explainer is still in production.', true); });
  document.addEventListener('explainer:restart', event => restartExplainer(event.detail));
}
