import { $, esc, state, api, notice, busy, uploadFile, refreshData, confirmDialog } from './core.js';
import { drawStageScene } from './stage.js';

// Step-by-step podcast setup: Cast → Topic → Demo → Look & sound → Review.
const STEPS = 5;
const SETTINGS_KEY = 'sales-forge-episode-defaults';
let step = 0;
const form = () => $('#episodeForm');

const REMEMBERED = ['layout', 'resolution', 'outputFormat', 'playbackMode', 'captionStyle', 'captionPosition', 'captionFont', 'captionSize', 'captionWords', 'captionsEnabled', 'accent', 'guestAccent', 'background', 'glowStrength', 'paneWidth', 'musicIntro', 'musicOutro', 'musicBed', 'musicVolume', 'interjections', 'hostTools', 'maxInterruptions', 'interjectProbability', 'targetMinutes', 'maxMinutes', 'requireGuestDemo'];

function readDefaults() { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; } }
function saveDefaults() {
  const f = form(), values = {};
  for (const name of REMEMBERED) { const field = f.elements[name]; if (field) values[name] = field.type === 'checkbox' ? field.checked : field.value; }
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(values)); } catch {}
}
function applyDefaults() {
  const f = form(), values = readDefaults();
  for (const [name, value] of Object.entries(values)) { const field = f.elements[name]; if (!field) continue; if (field.type === 'checkbox') field.checked = Boolean(value); else field.value = value; }
}

function populate(select, choices, current) { select.innerHTML = choices.map(([value, label]) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`).join(''); }

export function openEpisodeWizard(prefill = {}) {
  const f = form();
  f.reset();
  applyDefaults();
  if (!state.config?.storage?.remoteAssets) { f.elements.playbackMode.value = 'live'; }
  $('#playbackModeField').classList.toggle('hidden', !state.config?.storage?.remoteAssets);
  const choices = state.personas.map(p => [p.id, p.name]);
  populate($('#hostSelect'), choices, state.personas[0]?.id);
  populate($('#guestSelect'), choices, state.personas[1]?.id);
  for (const id of ['#cohostSelect', '#guest2Select', '#guest3Select']) populate($(id), [['', 'None'], ...choices], '');
  $('#wizardNoPersonas').classList.toggle('hidden', state.personas.length >= 2);
  for (const [name, value] of Object.entries(prefill)) if (f.elements[name]) f.elements[name].value = value;
  toggleDemo(); toggleCredentials(); updateLabels();
  $('#episodeLoginResult').textContent = 'Tries these details in a throwaway browser. Free.';
  go(0);
  $('#episodeDialog').showModal();
}

function go(target) {
  step = Math.max(0, Math.min(STEPS - 1, target));
  document.querySelectorAll('#episodeForm .wizard-step').forEach(section => section.classList.toggle('hidden', Number(section.dataset.step) !== step));
  document.querySelectorAll('#wizardSteps li').forEach(item => {
    const index = Number(item.dataset.step);
    item.className = index < step ? 'done' : index === step ? 'current' : '';
    if (index === step) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
  });
  $('#wizardBack').classList.toggle('hidden', step === 0);
  $('#wizardNext').classList.toggle('hidden', step === STEPS - 1);
  $('#wizardCreate').classList.toggle('hidden', step !== STEPS - 1);
  if (step === 3) drawPreview();
  if (step === 4) renderSummary();
  const first = document.querySelector(`#episodeForm .wizard-step[data-step="${step}"] input:not([type=hidden]), #episodeForm .wizard-step[data-step="${step}"] select, #episodeForm .wizard-step[data-step="${step}"] textarea`);
  first?.focus({ preventScroll: true });
}

// Validates only the fields on the current step, with the browser's own messages.
function stepValid() {
  const f = form();
  if (step === 0) {
    const ids = ['hostId', 'guestId', 'cohostId', 'guest2Id', 'guest3Id'].map(name => f.elements[name].value).filter(Boolean);
    if (!f.elements.hostId.value || !f.elements.guestId.value) { notice('Choose a host and a guest.'); return false; }
    if (new Set(ids).size !== ids.length) { notice('Each role needs a different persona.'); return false; }
  }
  if (step === 1 && !f.elements.subject.value.trim()) { f.elements.subject.reportValidity?.(); notice('Enter a subject for the episode.'); return false; }
  if (step === 2 && f.elements.requireGuestDemo.checked) {
    if (f.elements.demoUrl.value && !f.elements.demoUrl.checkValidity()) { f.elements.demoUrl.reportValidity(); return false; }
    if (f.elements.authRequired.checked && (!f.elements.demoUrl.value || !f.elements.demoUsername.value || !f.elements.demoPassword.value)) { notice('Add the product URL, username, and password for the sign-in.'); return false; }
  }
  return true;
}

function toggleDemo() { $('#demoFields').classList.toggle('hidden', !form().elements.requireGuestDemo.checked); }
function toggleCredentials() { const on = form().elements.authRequired.checked; $('#episodeCredentials').classList.toggle('hidden', !on); }
function updateLabels() {
  const f = form();
  $('#interjectValue').textContent = `${f.elements.interjectProbability.value}%`;
  $('#paneValue').textContent = `${f.elements.paneWidth.value}%`;
  $('#maxInterruptionsValue').textContent = `${f.elements.maxInterruptions.value} per episode`;
  $('#musicVolumeValue').textContent = `${f.elements.musicVolume.value}%`;
  $('#wizCaptionWordsValue').textContent = `${f.elements.captionWords.value} words`;
  const size = Number(f.elements.captionSize.value);
  $('#wizCaptionSizeValue').textContent = size <= 11 ? 'Small' : size <= 14 ? 'Medium' : size <= 18 ? 'Large' : 'Extra large';
}

// A draft episode built from the form, used by the preview and the submit.
function draftFromForm() {
  const f = form();
  const pick = id => state.personas.find(p => p.id === id);
  const personas = Object.fromEntries([['host', f.elements.hostId.value], ['guest', f.elements.guestId.value], ['cohost', f.elements.cohostId.value], ['guest2', f.elements.guest2Id.value], ['guest3', f.elements.guest3Id.value]].filter(([, id]) => id && pick(id)).map(([role, id]) => [role, pick(id)]));
  const [width, height] = f.elements.resolution.value.split('x').map(Number);
  return {
    personas, outline: { subject: f.elements.subject.value || 'Your episode subject', angle: f.elements.angle.value, points: f.elements.points.value },
    settings: {
      layout: f.elements.layout.value, maxMinutes: +f.elements.maxMinutes.value, width, height, outputFormat: f.elements.outputFormat.value, captionStyle: f.elements.captionStyle.value,
      captionOptions: { enabled: f.elements.captionsEnabled.checked, font: f.elements.captionFont.value, size: +f.elements.captionSize.value, position: f.elements.captionPosition.value, wordsPerCue: +f.elements.captionWords.value },
      accent: f.elements.accent.value, guestAccent: f.elements.guestAccent.value, background: f.elements.background.value, glowStrength: +f.elements.glowStrength.value, paneWidth: +f.elements.paneWidth.value,
      interjections: f.elements.interjections.checked, maxInterruptions: +f.elements.maxInterruptions.value, interjectProbability: +f.elements.interjectProbability.value / 100, targetMinutes: +f.elements.targetMinutes.value,
      music: { intro: f.elements.musicIntro.checked, outro: f.elements.musicOutro.checked, bed: f.elements.musicBed.checked, volume: +f.elements.musicVolume.value / 100 },
      playbackMode: state.config?.storage?.remoteAssets ? f.elements.playbackMode.value : 'live', hostTools: f.elements.hostTools.checked, requireGuestDemo: f.elements.requireGuestDemo.checked,
      demo: { url: f.elements.demoUrl.value, loginUrl: f.elements.demoLoginUrl.value, brief: f.elements.demoBrief.value, authRequired: f.elements.authRequired.checked, usernameSelector: f.elements.usernameSelector.value, passwordSelector: f.elements.passwordSelector.value, submitSelector: f.elements.submitSelector.value }
    }
  };
}

function drawPreview() {
  const canvas = $('#wizardPreview');
  if (!canvas || !$('#episodeDialog').open) return;
  const draft = draftFromForm();
  const demo = draft.settings.requireGuestDemo;
  drawStageScene(canvas, { episode: draft, screen: demo ? { type: 'browser', title: draft.settings.demo.url || 'app.example.com', content: 'The guest’s live product demo appears here.' } : { type: 'idle' }, speaker: 'guest', amplitude: 0.35, roleImages: {}, captionText: 'Here is how captions will look on the finished video' });
}

function renderSummary() {
  const draft = draftFromForm(), settings = draft.settings;
  const cast = Object.entries(draft.personas).map(([role, p]) => `${esc(p.name)} <span class="hint">(${role === 'cohost' ? 'co-host' : role.startsWith('guest') ? 'guest' : 'host'})</span>`).join(', ');
  const rows = [
    ['Cast', cast],
    ['Subject', esc(draft.outline.subject)],
    ['Length', settings.targetMinutes ? `About ${settings.targetMinutes} minutes (stops by ${settings.maxMinutes})` : `Host decides (stops by ${settings.maxMinutes} minutes)`],
    ['Demo', settings.requireGuestDemo ? `${esc(settings.demo.url || 'A relevant public page')}${settings.demo.authRequired ? ' · with sign-in' : ''}` : 'No live demo'],
    ['Video', `${settings.height}p · ${settings.outputFormat.toUpperCase()} · ${settings.captionOptions.enabled ? `${esc(settings.captionStyle)} captions` : 'no burned captions'}`],
    ['Sound', [settings.music.intro && 'intro', settings.music.outro && 'outro', settings.music.bed && 'music bed'].filter(Boolean).join(', ') || 'Voices only'],
    ['Generation', settings.playbackMode === 'background' ? 'Background — you can close the tab' : 'Live in this tab']
  ];
  $('#wizardSummary').innerHTML = rows.map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join('');
}

async function suggestOutline(button) {
  const f = form();
  if (!f.elements.subject.value.trim()) { notice('Enter a subject first.'); f.elements.subject.focus(); return; }
  await busy(button, async () => {
    try {
      const result = await api('/api/suggest-outline', { method: 'POST', body: JSON.stringify({ subject: f.elements.subject.value, hostId: f.elements.hostId.value, guestId: f.elements.guestId.value, demoBrief: f.elements.demoBrief.value }) });
      if (result.angle && (!f.elements.angle.value.trim() || await confirmDialog({ title: 'Replace your outline?', message: 'Replace the angle and points you wrote with the suggestion?', confirm: 'Replace' }))) {
        f.elements.angle.value = result.angle;
        f.elements.points.value = result.points.map(point => `- ${point}`).join('\n');
      }
    } catch (error) { notice(error.message); }
  }, 'Thinking…');
}

export async function testLogin(button, fields, resultEl) {
  const url = fields.url.value, username = fields.username.value, password = fields.password.value;
  if (!url || !username || !password) { resultEl.textContent = 'Enter the URL, username, and password first.'; return; }
  await busy(button, async () => {
    resultEl.textContent = 'Signing in to a throwaway browser…';
    try {
      const result = await api('/api/login-test', { method: 'POST', body: JSON.stringify({ url, loginUrl: fields.loginUrl.value, username, password, usernameSelector: fields.usernameSelector.value, passwordSelector: fields.passwordSelector.value, submitSelector: fields.submitSelector.value }) });
      resultEl.innerHTML = result.ok ? `<span class="ok-text">✓ Signed in. Landed on “${esc(result.title || 'the app')}”.</span>${result.image ? ` <a href="${esc(result.image)}" target="_blank" rel="noopener">See screenshot</a>` : ''}` : `<span class="error-text">✗ ${esc(result.error)}</span>`;
    } catch (error) { resultEl.innerHTML = `<span class="error-text">✗ ${esc(error.message)}</span>`; }
  }, 'Testing…');
}

async function createSamplePersonas(button) {
  await busy(button, async () => {
    try {
      const templates = state.templates || (state.templates = await api('/api/persona-templates'));
      const picks = [templates.find(t => t.id === 'interviewer'), templates.find(t => t.id === 'founder')].filter(Boolean);
      for (const template of picks) await api('/api/personas', { method: 'POST', body: JSON.stringify({ name: template.name, systemPrompt: template.systemPrompt, voice: template.voice, voiceStyle: template.voiceStyle, speechProvider: 'gateway', modelProvider: 'gateway' }) });
      await refreshData();
      openEpisodeWizard({ subject: form().elements.subject.value });
      notice('Created a host and a guest. Edit them any time under Personas.', true);
    } catch (error) { notice(error.message); }
  }, 'Creating…');
}

async function submit(event) {
  event.preventDefault();
  if (step !== STEPS - 1) { if (stepValid()) go(step + 1); return; }
  const f = form(), button = $('#wizardCreate');
  await busy(button, async () => {
    try {
      const draft = draftFromForm();
      const musicFile = f.elements.musicFile.files[0];
      if (musicFile) {
        if (musicFile.size > 15_000_000) throw new Error('Music tracks must be under 15 MB.');
        draft.settings.music.track = (await uploadFile(musicFile, 'music')).asset;
      }
      const ids = { hostId: f.elements.hostId.value, guestId: f.elements.guestId.value, cohostId: f.elements.cohostId.value, guest2Id: f.elements.guest2Id.value, guest3Id: f.elements.guest3Id.value };
      const episode = await api('/api/episodes', { method: 'POST', body: JSON.stringify({ ...ids, outline: draft.outline, settings: draft.settings }) });
      if (draft.settings.demo.authRequired) state.credentials.set(episode.id, { username: f.elements.demoUsername.value, password: f.elements.demoPassword.value });
      saveDefaults();
      $('#episodeDialog').close();
      await refreshData();
      location.hash = `#/studio/${episode.id}`;
      notice('Episode created. Press Start recording when you are ready.', true);
    } catch (error) { notice(error.message); }
  }, 'Creating…');
}

export function initWizard() {
  const f = form();
  f.addEventListener('submit', submit);
  $('#wizardNext').addEventListener('click', () => { if (stepValid()) go(step + 1); });
  $('#wizardBack').addEventListener('click', () => go(step - 1));
  document.querySelectorAll('#wizardSteps li').forEach(item => item.addEventListener('click', () => { const target = Number(item.dataset.step); if (target < step || stepValid()) go(target <= step + 1 ? target : step + 1); }));
  $('#suggestOutline').addEventListener('click', event => suggestOutline(event.currentTarget));
  $('#createSamplePersonas').addEventListener('click', event => createSamplePersonas(event.currentTarget));
  f.elements.requireGuestDemo.addEventListener('change', toggleDemo);
  f.elements.authRequired.addEventListener('change', toggleCredentials);
  f.addEventListener('input', () => { updateLabels(); if (step === 3) drawPreview(); });
  f.addEventListener('change', () => { if (step === 3) drawPreview(); });
  document.querySelector('[data-login-test="episode"]').addEventListener('click', event => testLogin(event.currentTarget, { url: f.elements.demoUrl, loginUrl: f.elements.demoLoginUrl, username: f.elements.demoUsername, password: f.elements.demoPassword, usernameSelector: f.elements.usernameSelector, passwordSelector: f.elements.passwordSelector, submitSelector: f.elements.submitSelector }, $('#episodeLoginResult')));
}
