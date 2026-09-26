import { timedSubtitleCues, cueAt } from './captions.js';
import { friendlyError } from './errors.js';
import { CAST_ROLES, castRoles, roleAccent, roleLabel } from './cast.js';
import { openPublishDialog } from './publish.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = { personas: [], episodes: [], explainers: [], config: null, account: null, clerk: null, current: null, eventSource: null, pollTimer: null, explainerPoll: null, recorder: null, recorderChunks: [], audioContext: null, audioElement: null, speechElements: {}, sandboxAudioElement: null, sandboxPlaying: false, screenVideoElement: null, screenVideoPlaying: false, pendingSandboxAudio: null, audioUnlock: null, analyser: null, audioDestination: null, queue: [], playing: false, screen: { type: 'idle', title: 'The stage is ready', content: '' }, speaker: null, caption: '', amplitude: 0, startTime: 0, roleImages: {}, screenImage: null, ended: false, seen: new Set(), credentials: new Map(), localVideoUrl: null, mediaCancels: new Map(), cursor: 0, awaitingPlan: new Set() };

async function api(path, options = {}) {
  const token = await state.clerk?.session?.getToken().catch(() => null);
  const response = await fetch(path, { ...options, headers: { ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function errorMarkup(message, className = 'row-error') { const info = friendlyError(message); return info ? `<small class="${className}" title="${esc(info.detail)}"><strong>${esc(info.title)}.</strong> ${esc(info.hint)}</small>` : ''; }
function notice(message, good = false) { const el = $('#notice'); el.textContent = message; el.classList.toggle('ok', good); el.classList.remove('hidden'); clearTimeout(notice.timer); notice.timer = setTimeout(() => el.classList.add('hidden'), 6000); }
async function refresh() { const [personas, episodes, explainers, config] = await Promise.all([api('/api/personas'), api('/api/episodes'), api('/api/explainers'), api('/api/config')]); state.personas = personas; state.episodes = episodes; state.explainers = explainers; state.config = config; render(); }
function person(id) { return state.personas.find(p => p.id === id); }
function episodePerson(episode, role) { return episode?.personas?.[role] || person(episode?.[`${role}Id`]); }
function formatClock(seconds) { const total = Math.floor(Number(seconds) || 0); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`; }
function shortDate(date) { return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
function avatar(p, big = false) { return p?.image ? `<img class="${big?'avatar-lg':'avatar'}" src="${esc(p.image)}" alt="">` : `<span class="${big?'avatar-lg':'avatar'}">${esc((p?.name || '?')[0].toUpperCase())}</span>`; }
function navigate(name) { $$('.view').forEach(v => v.classList.add('hidden')); $(`#view-${name}`).classList.remove('hidden'); $$('.nav').forEach(b => b.classList.toggle('active', b.dataset.view === name)); $('#crumb').textContent = name.toUpperCase(); window.scrollTo(0, 0); }
function render() {
  $('#modelDot').classList.toggle('ready', state.config?.ready.model); $('#sandboxDot').classList.toggle('ready', state.config?.ready.sandbox);
  $('#modelState').textContent = state.config?.ready.model ? 'Model connected' : 'Model key needed';
  $('#sandboxState').textContent = state.config?.ready.sandbox ? 'Sandbox connected' : 'Sandbox key needed';
  const epCard = e => `<article class="card" data-episode="${e.id}" role="button" tabindex="0"><div class="card-top"><span class="tag ${esc(e.status)}">${esc(e.status)}</span><span class="card-arrow">↗</span></div><h3>${esc(e.outline.subject)}</h3><p>${esc(episodePerson(e,'host')?.name || 'Host')} with ${esc(episodePerson(e,'guest')?.name || 'Guest')} · ${shortDate(e.createdAt)}</p></article>`;
  $('#recentEpisodes').innerHTML = state.episodes.length ? state.episodes.slice(0, 3).map(epCard).join('') : '<div class="empty"><strong>No episodes yet</strong>Choose two personas and start your first recording.</div>';
  $('#recentPersonas').innerHTML = state.personas.length ? state.personas.slice(0, 6).map(p => `<div class="persona-chip">${avatar(p)}${esc(p.name)}</div>`).join('') : '<div class="empty">Your cast starts with a persona.</div>';
  $('#personaGrid').innerHTML = state.personas.length ? state.personas.map(p => `<article class="persona-card">${avatar(p,true)}<h3>${esc(p.name)}</h3><p>${esc(p.systemPrompt)}</p><div class="persona-card-foot"><span>${p.knowledge?.length || 0} knowledge files${p.knowledgeStats?.semantic ? ' · semantic search' : ''} · ${esc(p.voice)}</span><span class="card-buttons"><button data-chat="${p.id}">Test chat</button><button data-edit="${p.id}">Edit →</button></span></div></article>`).join('') : '<div class="empty"><strong>No personas yet</strong>Create a host and a guest to begin.</div>';
  $('#episodeList').innerHTML = state.episodes.length ? state.episodes.map(e => `<article class="episode-row" data-episode="${e.id}" role="button" tabindex="0"><div><div class="eyebrow">${shortDate(e.createdAt)}</div><h3>${esc(e.outline.subject)}</h3><p>${esc(episodePerson(e,'host')?.name || 'Host')} × ${esc(episodePerson(e,'guest')?.name || 'Guest')} · ${e.turns?.length || 0} spoken segments</p></div><div class="episode-row-right"><span class="tag ${esc(e.status)}">${esc(e.status)}</span>${e.video || e.mp4 ? `<a class="row-download" href="${esc(e.mp4 || e.video)}" download>Download video</a>` : ''}${['complete','stopped','failed','interrupted'].includes(e.status) ? `<button class="row-action" data-restart-episode="${esc(e.id)}">Restart · 20 credits</button>` : ''}${e.error || e.videoError ? errorMarkup(e.error || e.videoError) : ''}<span class="card-arrow">↗</span></div></article>`).join('') : '<div class="empty"><strong>Nothing recorded yet</strong>Create an episode to start the archive.</div>';
  $('#explainerList').innerHTML = state.explainers.length ? state.explainers.map(e => `<article class="episode-row explainer-row"><div><div class="eyebrow">${shortDate(e.createdAt)} · ${esc(new URL(e.url).hostname)}</div><h3>${esc(e.title)}</h3><p>${esc(e.summary || e.progress || e.brief)}</p>${e.chapters?.length ? `<ol class="chapter-list">${e.chapters.map(chapter => `<li><span>${formatClock(chapter.start)}</span> ${esc(chapter.title)}</li>`).join('')}</ol>` : ''}</div><div class="episode-row-right"><span class="tag ${esc(e.status)}">${esc(e.status.replace('_', ' '))}</span>${e.video ? `<a class="row-download" href="${esc(e.video)}" download>Download MP4</a><a class="row-download secondary" href="${esc(e.captions)}" download>Captions</a>` : ''}${e.status === 'awaiting_approval' ? `<button class="row-action primary" data-review-plan="${esc(e.id)}">Review scene plan</button>` : ''}${e.status === 'complete' && e.video ? `<button class="row-action primary" data-publish-explainer="${esc(e.id)}">Publish</button>` : ''}${e.status === 'complete' && e.scenes?.length ? `<button class="row-action" data-rerender-explainer="${esc(e.id)}">Edit &amp; re-render · 10 credits</button>` : ''}${e.status === 'draft' && e.authRequired ? `<button class="row-action" data-retry-explainer="${esc(e.id)}">Resume secure sign-in</button>` : ''}${['complete','failed'].includes(e.status) ? `<button class="row-action" data-restart-explainer="${esc(e.id)}">Restart · 30 credits</button>` : ''}${e.error ? errorMarkup(e.error) : ''}${e.rerenderError ? errorMarkup(e.rerenderError) : ''}</div></article>`).join('') : '<div class="empty"><strong>No explainers yet</strong>Give the agent a URL and the workflow your customer needs to understand.</div>';
  renderAccount();
}

function renderAccount() {
  const a = state.account;
  if (!a) return;
  $('#creditCount').textContent = a.credits;
  $('#billingCredits').textContent = a.credits;
  $('#billingPlan').textContent = (a.plan || 'none').toUpperCase();
  $('#billingStatus').textContent = (a.subscriptionStatus || 'none').replace('_', ' ').toUpperCase();
  $('#billingRenewal').textContent = a.periodEnd ? shortDate(a.periodEnd) : '—';
}

function planMarkup(context = 'public') {
  return (state.config?.plans || []).map(plan => `<article class="price-row ${plan.id === 'pro' ? 'recommended' : ''}"><div class="plan-index">${String((state.config.plans || []).indexOf(plan) + 1).padStart(2, '0')}</div><div class="plan-copy"><h3>${esc(plan.name)}</h3><p>${plan.credits} credits each paid month</p></div><div class="plan-price"><strong>$${plan.monthly}</strong><span>/ month</span></div><div class="plan-output"><span>${Math.floor(plan.credits / 20)} podcast equivalents</span><span>${Math.floor(plan.credits / 30)} explainer equivalents</span></div><button class="button ${plan.id === 'pro' ? 'button-signal' : 'button-ink'}" data-plan="${plan.id}" data-context="${context}">${context === 'public' ? 'Subscribe to' : 'Choose'} ${esc(plan.name)}</button></article>`).join('');
}

function renderPlans() {
  $('#publicPlans').innerHTML = planMarkup('public');
  $('#gatePlans').innerHTML = planMarkup('gate');
  $('#workspacePlans').innerHTML = planMarkup('workspace');
}
function populateSelect(select, choices, current) { select.innerHTML = choices.map(([value,label]) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`).join(''); }
function openPersona(existing = null) {
  const form = $('#personaForm'); form.reset(); form.dataset.edit = existing?.id || '';
  $('#personaDialogTitle').textContent = existing ? 'Edit persona' : 'New persona';
  populateSelect($('#modelProvider'), (state.config?.providers.models || []).map(x => [x,x]), existing?.modelProvider || 'gateway');
  populateSelect($('#speechProvider'), (state.config?.providers.speech || []).map(x => [x,x]), existing?.speechProvider || (state.config?.providers.ready.speech.openai ? 'openai' : 'gateway'));
  updateVoiceSuggestions(); $('#voiceSelect').value = existing?.voice || (state.config?.providers.voices?.[$('#speechProvider').value]?.[0] || '');
  if (existing) for (const key of ['name','systemPrompt','model','voiceStyle']) form.elements[key].value = existing[key] || '';
  form._image = existing?.image || '';
  const stats = new Map((existing?.knowledgeStats?.files || []).map(file => [file.name, file]));
  form._knowledge = (existing?.knowledge || []).map(file => ({ name: file.name, keep: true, characters: file.characters, source: file.source, chunks: stats.get(file.name)?.chunks, embedded: stats.get(file.name)?.embedded }));
  $('#imagePreview').innerHTML = form._image ? `<img src="${esc(form._image)}" alt="Selected display image">` : 'No image selected';
  $('#templateField').classList.toggle('hidden', Boolean(existing));
  loadTemplates().catch(() => {});
  renderKnowledgeList();
  $('#personaDialog').showModal();
}
function openEpisodeDialog() {
  if (state.personas.length < 2) { notice('Create two personas before making an episode.'); navigate('personas'); return; }
  $('#episodeForm').reset();
  $('#episodeCredentials').classList.add('hidden');
  for (const name of ['demoUsername','demoPassword']) $('#episodeForm').elements[name].required = false;
  const format = $('#episodeForm').elements.outputFormat;
  for (const option of format.options) option.disabled = false;
  format.value = 'both';
  $('#interjectValue').textContent = '3%'; $('#paneValue').textContent = '66%';
  $('#playbackModeField').classList.toggle('hidden', !state.config?.storage?.remoteAssets);
  populateSelect($('#hostSelect'), state.personas.map(p => [p.id,p.name]), state.personas[0].id);
  populateSelect($('#guestSelect'), state.personas.map(p => [p.id,p.name]), state.personas[1].id);
  for (const id of ['#cohostSelect','#guest2Select','#guest3Select']) populateSelect($(id), [['', 'None'], ...state.personas.map(p => [p.id,p.name])], '');
  $('#maxInterruptionsValue').textContent = '4 per episode'; $('#musicVolumeValue').textContent = '8%';
  $('#episodeDialog').showModal();
}
function renderKnowledgeList() {
  const form = $('#personaForm'), pending = [...form.elements.knowledgeFiles.files].map(file => ({ name: file.name, pendingFile: true, characters: file.size }));
  const files = [...form._knowledge, ...pending];
  $('#knowledgeList').innerHTML = files.length ? files.map((file, index) => `<li><span><strong>${esc(file.name)}</strong> <small>${file.pendingFile ? 'will be read on save' : `${Math.round((file.characters || file.text?.length || 0) / 1000)}k characters${file.chunks ? ` · ${file.chunks} passages${file.embedded ? ', searchable by meaning' : ''}` : file.keep ? '' : ' · new'}`}${file.source ? ` · <a href="${esc(file.source)}" target="_blank" rel="noopener">source</a>` : ''}</small></span>${file.pendingFile ? '' : `<button type="button" class="icon-button" data-remove-knowledge="${index}" aria-label="Remove ${esc(file.name)}">×</button>`}</li>`).join('') : '<li class="hint">No knowledge yet. Add files or web pages the persona should draw on.</li>';
}
async function loadTemplates() {
  if (state.templates) return;
  state.templates = await api('/api/persona-templates');
  $('#personaTemplate').innerHTML = '<option value="">Blank persona</option>' + state.templates.map(template => `<option value="${esc(template.id)}">${esc(template.label)}</option>`).join('');
}
async function previewVoice() {
  const form = $('#personaForm'), button = $('#previewVoice'); button.disabled = true; button.textContent = 'Generating…';
  try {
    const token = await state.clerk?.session?.getToken().catch(() => null);
    const response = await fetch('/api/voices/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ speechProvider: form.elements.speechProvider.value, voice: form.elements.voice.value, voiceStyle: form.elements.voiceStyle.value, name: form.elements.name.value }) });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'The voice preview failed.');
    const audio = new Audio(URL.createObjectURL(await response.blob())); await audio.play();
  } catch (error) { notice(error.message); } finally { button.disabled = false; button.textContent = '▶ Preview voice'; }
}
function openChat(persona) {
  const form = $('#chatForm'); form.dataset.personaId = persona.id; form._history = []; form.reset();
  $('#chatTitle').textContent = `Talk to ${persona.name}`; $('#chatLog').innerHTML = '';
  $('#chatDialog').showModal(); form.elements.message.focus();
}
async function sendChat(event) {
  event.preventDefault();
  const form = event.currentTarget, message = form.elements.message.value.trim(), button = form.querySelector('[type=submit]');
  if (!message) return;
  const log = $('#chatLog'), name = person(form.dataset.personaId)?.name || 'Persona';
  log.insertAdjacentHTML('beforeend', `<div class="chat-line you"><strong>You</strong><p>${esc(message)}</p></div>`);
  form.elements.message.value = ''; button.disabled = true;
  try {
    const result = await api(`/api/personas/${form.dataset.personaId}/chat`, { method: 'POST', body: JSON.stringify({ message, history: form._history }) });
    form._history.push({ role: 'tester', text: message }, { role: 'persona', text: result.reply });
    log.insertAdjacentHTML('beforeend', `<div class="chat-line persona"><strong>${esc(name)}</strong><p>${esc(result.reply)}</p>${result.sources.length ? `<small class="sources">Sources: ${result.sources.map(esc).join(', ')}</small>` : result.retrieved.length ? '<small class="sources">No knowledge file was cited.</small>' : ''}</div>`);
  } catch (error) { log.insertAdjacentHTML('beforeend', `<div class="chat-line error">${esc(error.message)}</div>`); }
  finally { button.disabled = false; log.scrollTop = log.scrollHeight; form.elements.message.focus(); }
}
function updateVoiceSuggestions() { const voices = state.config?.providers.voices?.[$('#speechProvider').value] || []; $('#voiceSuggestions').innerHTML = voices.map(voice => `<option value="${esc(voice)}"></option>`).join(''); }
async function uploadFile(file, kind) {
  const token = await state.clerk?.session?.getToken();
  const response = await fetch(`/api/uploads?kind=${kind}&name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: file });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Could not upload ${file.name}`);
  return data;
}
async function extractFile(file) {
  if (/\.(txt|md|csv|json)$/i.test(file.name)) return file.text();
  const token = await state.clerk?.session?.getToken();
  const response = await fetch(`/api/extract?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: file });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Could not read ${file.name}`);
  return data.text;
}
async function savePersona(event) {
  event.preventDefault(); const form = event.currentTarget; const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try {
    const imageFile = form.elements.imageFile.files[0];
    let image = form._image || '';
    if (imageFile) {
      if (imageFile.size > 3_000_000) throw new Error('Display images must be under 3 MB.');
      image = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(imageFile); });
    }
    const knowledge = form._knowledge.map(file => file.keep ? { name: file.name, keep: true } : { name: file.name, text: file.text, source: file.source });
    for (const file of form.elements.knowledgeFiles.files) {
      if (file.size > 5_000_000) throw new Error(`${file.name} exceeds the 5 MB file limit.`);
      knowledge.push({ name: file.name, text: await extractFile(file) });
    }
    const data = { name: form.elements.name.value, systemPrompt: form.elements.systemPrompt.value, modelProvider: form.elements.modelProvider.value, model: form.elements.model.value, speechProvider: form.elements.speechProvider.value, voice: form.elements.voice.value, voiceStyle: form.elements.voiceStyle.value, image, knowledge };
    await api(form.dataset.edit ? `/api/personas/${form.dataset.edit}` : '/api/personas', { method: form.dataset.edit ? 'PUT' : 'POST', body: JSON.stringify(data) });
    $('#personaDialog').close(); await refresh(); notice('Persona saved.', true);
  } catch (error) { notice(error.message); } finally { submit.disabled = false; }
}
async function saveEpisode(event) {
  event.preventDefault(); const form = event.currentTarget; const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try {
    const [width,height] = form.elements.resolution.value.split('x').map(Number);
    const authRequired = form.elements.authRequired.checked;
    if (authRequired && (!form.elements.demoUrl.value || !form.elements.demoUsername.value || !form.elements.demoPassword.value)) throw new Error('Add the platform URL, username, and password before creating this authenticated demo.');
    let musicTrack = '';
    const musicFile = form.elements.musicFile.files[0];
    if (musicFile) {
      if (musicFile.size > 15_000_000) throw new Error('Music tracks must be under 15 MB.');
      musicTrack = (await uploadFile(musicFile, 'music')).asset;
    }
    const data = { hostId: form.elements.hostId.value, guestId: form.elements.guestId.value, cohostId: form.elements.cohostId.value, guest2Id: form.elements.guest2Id.value, guest3Id: form.elements.guest3Id.value, outline: { subject: form.elements.subject.value, angle: form.elements.angle.value, points: form.elements.points.value }, settings: { layout: form.elements.layout.value, maxMinutes: +form.elements.maxMinutes.value, width, height, outputFormat: form.elements.outputFormat.value, captionStyle: form.elements.captionStyle.value, accent: form.elements.accent.value, guestAccent: form.elements.guestAccent.value, background: form.elements.background.value, glowStrength: +form.elements.glowStrength.value, paneWidth: +form.elements.paneWidth.value, interjections: form.elements.interjections.checked, maxInterruptions: +form.elements.maxInterruptions.value, targetMinutes: +form.elements.targetMinutes.value, music: { intro: form.elements.musicIntro.checked, outro: form.elements.musicOutro.checked, bed: form.elements.musicBed.checked, volume: +form.elements.musicVolume.value / 100, track: musicTrack }, playbackMode: state.config?.storage?.remoteAssets ? form.elements.playbackMode.value : 'live', interjectProbability: +form.elements.interjectProbability.value / 100, hostTools: form.elements.hostTools.checked, requireGuestDemo: form.elements.requireGuestDemo.checked, demo: { url: form.elements.demoUrl.value, loginUrl: form.elements.demoLoginUrl.value, brief: form.elements.demoBrief.value, authRequired, usernameSelector: form.elements.usernameSelector.value, passwordSelector: form.elements.passwordSelector.value, submitSelector: form.elements.submitSelector.value } } };
    const episode = await api('/api/episodes', { method: 'POST', body: JSON.stringify(data) });
    if (authRequired) state.credentials.set(episode.id, { username: form.elements.demoUsername.value, password: form.elements.demoPassword.value });
    $('#episodeDialog').close(); await refresh(); await openStudio(episode.id);
  } catch (error) { notice(error.message); } finally { submit.disabled = false; }
}

async function openStudio(id) {
  if (state.eventSource) state.eventSource.close();
  clearTimeout(state.pollTimer);
  if (state.current?.id !== id && state.recorder?.state === 'recording') await finishRecording();
  if (state.localVideoUrl) { URL.revokeObjectURL(state.localVideoUrl); state.localVideoUrl = null; }
  state.current = await api(`/api/episodes/${id}`);
  state.current.turns = [];
  state.screen = { type: 'idle', title: 'The stage is ready', content: '' }; state.screenImage = null; state.screenVideoElement = null; state.screenVideoPlaying = false; state.speaker = null; state.caption = ''; state.amplitude = 0; state.queue = []; state.playing = false; state.sandboxPlaying = false; state.pendingSandboxAudio = null; state.seen = new Set(); state.ended = ['complete','stopped','failed','interrupted'].includes(state.current.status);
  state.roleImages = Object.fromEntries(await Promise.all(castRoles(state.current).map(async role => [role, await loadImage(episodePerson(state.current, role)?.image)])));
  $('#studioTitle').textContent = state.current.outline.subject;
  $('#studioMeta').textContent = `${castRoles(state.current).map(role => episodePerson(state.current, role)?.name || roleLabel(role)).join(' × ')} · ${shortDate(state.current.createdAt)}`;
  $('#transcriptPane').innerHTML = ''; $('#activityPane').innerHTML = '';
  $('#startEpisode').classList.toggle('hidden', state.current.status !== 'draft');
  $('#enableAudio').classList.add('hidden');
  $('#restartEpisode').classList.toggle('hidden', !['complete','stopped','failed','interrupted'].includes(state.current.status));
  $('#stopEpisode').classList.toggle('hidden', !['running','preparing'].includes(state.current.status));
  setStatus(state.current.status);
  renderDownloads(); navigate('studio');
  for (const event of state.current.events) processEvent(event, true);
  state.cursor = state.current.events.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0);
  renderStudioError(); setStatus(state.current.status);
  drawStage();
  if (['running','preparing','draft'].includes(state.current.status) && state.config?.realtime === 'poll') {
    pollEpisode(id);
  } else if (['running','preparing','draft'].includes(state.current.status)) {
    state.eventSource = new EventSource(`/api/episodes/${id}/events`);
    state.eventSource.onmessage = e => processEvent(JSON.parse(e.data));
    state.eventSource.onerror = () => { if (!state.ended) notice('Live connection interrupted. Reconnecting…'); };
  }
}
// Polls only the events after our cursor, so long episodes stay cheap to follow live.
async function pollEpisode(id) {
  if (state.current?.id !== id || state.ended) return;
  let delay = 450;
  try {
    const data = await api(`/api/episodes/${id}/events?format=json&after=${state.cursor || 0}`);
    for (const event of data.events || []) processEvent(event);
    state.cursor = data.cursor || state.cursor;
    Object.assign(state.current, data.episode || {});
    if (!data.events?.length) delay = 900;
    renderDownloads(); renderStudioError(); setStatus(state.current.status);
  } catch (cause) {
    delay = 2500;
    if (!state.ended) notice(`Live update failed: ${cause.message}`);
  }
  if (state.current?.id === id && !state.ended) state.pollTimer = setTimeout(() => pollEpisode(id), delay);
}
function renderStudioError() {
  const e = state.current, panel = $('#studioError'); if (!panel || !e) return;
  const message = e.status === 'failed' ? e.error : e.videoStatus === 'failed' ? e.videoError : '';
  const info = friendlyError(message);
  panel.classList.toggle('hidden', !info);
  panel.innerHTML = info ? `<strong>${esc(info.title)}</strong><p>${esc(info.hint)}</p><details><summary>Technical details</summary><code>${esc(info.detail)}</code></details>` : '';
}
function setStatus(status) {
  const e = state.current;
  $('#liveStatus').textContent = status.toUpperCase(); $('#liveStatus').className = `pill ${status}`;
  $('#stopEpisode').classList.toggle('hidden', !['running','preparing'].includes(status));
  $('#restartEpisode').classList.toggle('hidden', !['complete','stopped','failed','interrupted'].includes(status));
  $('#resumeEpisode').classList.toggle('hidden', !(['failed','interrupted'].includes(status) && e?.turns?.length));
  $('#renderEpisode').classList.toggle('hidden', !(['complete','stopped'].includes(status) && e?.videoStatus === 'failed' && state.config?.storage?.remoteAssets));
}
function renderDownloads() {
  const e = state.current; const transcript = new Blob([e.turns.map(t => `${t.role.toUpperCase()}: ${t.text}`).join('\n\n')], { type: 'text/plain' });
  const transcriptUrl = URL.createObjectURL(transcript);
  const stem = e.outline.subject.replace(/[^a-z0-9]/gi,'-').replace(/-+/g,'-').replace(/^-|-$/g,'') || 'podcast';
  const localFallback = state.config?.storage?.remoteAssets ? null : state.localVideoUrl;
  const video = e.mp4 || e.video || localFallback;
  const publishButton = e.mp4 && ['complete','stopped'].includes(e.status) ? '<button type="button" class="video-download" data-publish-episode>Publish · YouTube, shorts, languages, feed</button>' : '';
  $('#downloads').innerHTML = `${publishButton}${video ? `<a class="video-download" href="${esc(video)}" download="${esc(stem)}.${e.mp4 ? 'mp4' : 'webm'}">↓ Download finished video</a>` : ''}${e.captions?`<a class="video-download secondary" href="${esc(e.captions)}" download="${esc(stem)}.srt">↓ Download captions</a>`:''}${e.videoStatus==='processing'?'<span class="hint">The edited MP4 and captions are being prepared…</span>':''}${e.videoStatus==='failed'?`<span class="row-error">${esc(e.videoError||'The final media failed quality validation.')}</span>`:''}<a href="${transcriptUrl}" download="${esc(stem)}-transcript.txt">↓ Transcript</a><a href="/api/episodes/${e.id}" download="episode.json" target="_blank">Episode data ↗</a>${e.mp4 && e.video ? `<a href="${esc(e.video)}" download="${esc(stem)}.webm">↓ WebM source copy</a>` : ''}`;
  const player = $('#reviewPlayer');
  player.classList.toggle('hidden', !video);
  if (video && player.dataset.source !== video) { player.dataset.source = video; player.src = video; }
}
async function pollPodcastVideo(id) {
  if (state.current?.id !== id) return;
  try {
    const fresh = await api(`/api/episodes/${id}`);
    Object.assign(state.current, { video: fresh.video, mp4: fresh.mp4, captions: fresh.captions, videoStatus: fresh.videoStatus, videoError: fresh.videoError, quality: fresh.quality });
    renderDownloads(); renderStudioError(); setStatus(state.current.status);
    if (!fresh.videoStatus || fresh.videoStatus === 'processing') setTimeout(() => pollPodcastVideo(id), 2500);
    else if (fresh.mp4) notice('The MP4 is ready to download.', true);
  } catch (error) { notice(`Could not check MP4 progress: ${error.message}`); }
}
function credentialsForCurrentEpisode() {
  if (!state.current?.settings?.demo?.authRequired) return Promise.resolve(null);
  const cached = state.credentials.get(state.current.id);
  if (cached) return Promise.resolve(cached);
  const dialog = $('#credentialsDialog'), form = $('#credentialsForm');
  form.reset(); $('#credentialUrl').value = state.current.settings.demo.url || '';
  return new Promise(resolve => {
    let value = null;
    const submit = event => { event.preventDefault(); value = { username: form.elements.username.value, password: form.elements.password.value }; dialog.close(); };
    const openDesktop = async () => {
      const popup = window.open('about:blank', '_blank'); if (popup) popup.opener = null;
      try { const { liveUrl } = await api(`/api/episodes/${state.current.id}/desktop`); if (popup) popup.location = liveUrl; else window.open(liveUrl, '_blank', 'noopener'); }
      catch (error) { popup?.close(); notice(error.message); }
    };
    const desktopReady = async () => {
      const button = $('#episodeDesktopReady'); button.disabled = true;
      try { await api(`/api/episodes/${state.current.id}/desktop-ready`, { method: 'POST' }); value = { manualPrepared: true }; dialog.close(); }
      catch (error) { notice(error.message); }
      finally { button.disabled = false; }
    };
    const close = () => { form.removeEventListener('submit', submit); $('#openEpisodeDesktop').removeEventListener('click', openDesktop); $('#episodeDesktopReady').removeEventListener('click', desktopReady); dialog.removeEventListener('close', close); resolve(value); };
    form.addEventListener('submit', submit); $('#openEpisodeDesktop').addEventListener('click', openDesktop); $('#episodeDesktopReady').addEventListener('click', desktopReady); dialog.addEventListener('close', close); dialog.showModal();
  });
}
function appendTranscript(role, text, sources = [], eventId = '') { const pane = $('#transcriptPane'); const name = episodePerson(state.current, role)?.name || roleLabel(role); pane.insertAdjacentHTML('beforeend', `<div class="transcript-item ${esc(role)}" data-event="${esc(eventId)}" style="--role:${roleAccent(state.current?.settings, role)}"><strong>${esc(name)} · ${esc(roleLabel(role))}</strong><p>${esc(text)}</p>${sources?.length ? `<small class="sources">Sources: ${sources.map(esc).join(', ')}</small>` : ''}</div>`); pane.scrollTop = pane.scrollHeight; }
function appendActivity(title, content, assetUrl) { const pane = $('#activityPane'); const link = assetUrl?.startsWith('/assets/') ? `<br><a href="${esc(assetUrl)}" target="_blank" rel="noopener">Open artifact ↗</a>` : ''; pane.insertAdjacentHTML('beforeend', `<div class="activity-item"><strong>${esc(title)}</strong>${esc(content || '')}${link}</div>`); pane.scrollTop = pane.scrollHeight; }
function processEvent(event, history = false) {
  if (state.seen.has(event.id)) return; state.seen.add(event.id);
  if (event.type === 'status') {
    state.current.status = event.status; if (event.error) state.current.error = event.error; setStatus(event.status); renderStudioError();
    if (['complete','stopped','failed'].includes(event.status)) { state.ended = true; state.eventSource?.close(); maybeFinish(); }
  }
  if (event.type === 'speech') {
    state.current.turns.push({ role: event.role, text: event.text });
    appendTranscript(event.role, event.text, event.sources, event.id);
    if (!history && !event.acknowledged) { state.queue.push(event); playQueue(); }
  }
  if (event.type === 'tool_start') { appendActivity(`Started ${event.tool}`, JSON.stringify(event.input).slice(0, 350)); state.screen = { type: 'working', title: `${event.tool} in progress`, content: 'Live sandbox activity…' }; }
  if (event.type === 'tool_output') { state.screen = event.screen || { type: 'terminal', title: event.tool, content: event.chunk }; }
  if (event.type === 'tool_end') { state.screen = event.screen; appendActivity(`${event.tool} finished`, event.screen?.content?.slice(0, 500), event.screen?.asset || event.screen?.video || event.screen?.image); if (event.screen?.image) loadImage(event.screen.image).then(img => { state.screenImage = img; drawStage(); }); if (!history && event.screen?.video) playScreenVideo(event.screen.video); if (!history && event.screen?.audio) playSandboxAudio(event.screen.audio); }
  if (event.type === 'interrupt') appendActivity(`${event.by} interjected`, event.reason);
  if (event.type === 'notice') appendActivity('Note', event.message);
  drawStage();
}
const SILENT_AUDIO = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
function initializeAudioGraph() {
  if (state.audioContext && CAST_ROLES.every(role => state.speechElements[role]) && state.sandboxAudioElement) return;
  state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  state.audioDestination = state.audioContext.createMediaStreamDestination();
  state.analyser = state.audioContext.createAnalyser(); state.analyser.fftSize = 256;
  for (const role of CAST_ROLES) {
    const element = new Audio(); element.preload = 'auto'; state.speechElements[role] = element;
    const source = state.audioContext.createMediaElementSource(element);
    source.connect(state.analyser);
  }
  state.audioElement = state.speechElements.host;
  state.analyser.connect(state.audioDestination); state.analyser.connect(state.audioContext.destination);
  state.sandboxAudioElement = new Audio(); state.sandboxAudioElement.preload = 'auto';
  state.sandboxAudioElement.onended = () => { state.sandboxPlaying = false; maybeFinish(); };
  const sandboxSource = state.audioContext.createMediaElementSource(state.sandboxAudioElement);
  sandboxSource.connect(state.audioDestination); sandboxSource.connect(state.audioContext.destination);
}
function unlockAudio() {
  initializeAudioGraph();
  const attempts = [];
  if (state.audioContext.state === 'suspended') attempts.push(state.audioContext.resume());
  for (const element of [...Object.values(state.speechElements), state.sandboxAudioElement]) {
    element.src = SILENT_AUDIO;
    const attempt = element.play();
    attempts.push(Promise.resolve(attempt).then(() => { element.pause(); element.removeAttribute('src'); element.load(); }));
  }
  state.audioUnlock = Promise.allSettled(attempts);
  return state.audioUnlock;
}
function playbackBlocked(error) {
  return error?.name === 'NotAllowedError' || /not allowed|user agent|permission|autoplay/i.test(error?.message || String(error));
}
function showAudioGate() {
  $('#enableAudio').classList.remove('hidden');
  notice('The browser paused audio. Click Enable audio to continue the recording.');
}
function playToEnd(element, url) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { element.removeEventListener('ended', ended); element.removeEventListener('error', failed); state.mediaCancels.delete(element); };
    const ended = () => { cleanup(); resolve(); };
    const failed = () => { const error = element.error || new Error('The audio file could not be played.'); cleanup(); reject(error); };
    state.mediaCancels.set(element, () => { cleanup(); reject(new DOMException('Playback stopped.', 'AbortError')); });
    element.addEventListener('ended', ended, { once: true });
    element.addEventListener('error', failed, { once: true });
    element.src = url;
    Promise.resolve(element.play()).catch(error => { cleanup(); reject(error); });
  });
}
async function playSandboxAudio(url) {
  initializeAudioGraph();
  state.sandboxPlaying = true;
  try {
    await playToEnd(state.sandboxAudioElement, url);
    state.pendingSandboxAudio = null;
  } catch (error) {
    state.sandboxPlaying = false;
    if (state.ended && error?.name === 'AbortError') return;
    if (playbackBlocked(error)) { state.pendingSandboxAudio = url; showAudioGate(); return; }
    notice(`Sandbox sound failed: ${error.message || error}`);
  }
  state.sandboxPlaying = false; maybeFinish();
}
async function startRecording() {
  const e = state.current; const canvas = $('#stage'); canvas.width = e.settings.width; canvas.height = e.settings.height;
  initializeAudioGraph();
  if (state.audioUnlock) await state.audioUnlock;
  if (state.audioContext.state === 'suspended') await state.audioContext.resume();
  if (state.config?.storage?.remoteAssets) {
    state.recorderChunks = [];
    state.recorder = { state: 'recording', serverTimeline: true };
    state.startTime = Date.now(); state.ended = false;
    requestAnimationFrame(tick);
    return;
  }
  const stream = new MediaStream([...canvas.captureStream(30).getTracks(), ...state.audioDestination.stream.getTracks()]);
  const mime = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(x => MediaRecorder.isTypeSupported(x));
  state.recorderChunks = []; state.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
  state.recorder.ondataavailable = e => { if (e.data.size) state.recorderChunks.push(e.data); };
  state.recorder.start(1000); state.startTime = Date.now(); state.ended = false;
  requestAnimationFrame(tick);
}
async function finishRecording() {
  const recorder = state.recorder; if (!recorder || recorder.state === 'inactive') return;
  if (recorder.serverTimeline) {
    recorder.state = 'inactive';
    state.current.videoStatus = state.current.videoStatus === 'failed' ? 'failed' : 'processing';
    renderDownloads();
    notice('The edited MP4 and captions are being assembled from the completed media timeline.', true);
    pollPodcastVideo(state.current.id);
    return;
  }
  await new Promise(resolve => { recorder.addEventListener('stop', resolve, { once: true }); recorder.stop(); });
  const blob = new Blob(state.recorderChunks, { type: recorder.mimeType || 'video/webm' });
  if (!blob.size) return;
  if (state.localVideoUrl) URL.revokeObjectURL(state.localVideoUrl);
  state.localVideoUrl = URL.createObjectURL(blob);
  renderDownloads();
  notice('The video is ready to download. Saving a cloud copy…', true);
  try {
    let data;
    if (state.config?.storage?.remoteAssets) {
      const pathname = await window.uploadPodcastVideo(state.current.id, blob);
      data = await api(`/api/episodes/${state.current.id}/video/complete`, { method: 'POST', body: JSON.stringify({ pathname }) });
    } else {
      const token = await state.clerk?.session?.getToken();
      const response = await fetch(`/api/episodes/${state.current.id}/video`, { method: 'PUT', headers: { 'Content-Type': 'video/webm', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: blob });
      data = await response.json(); if (!response.ok) throw new Error(data.error || 'Upload failed');
    }
    state.current.video = data.video; state.current.videoStatus = data.videoStatus; if (data.mp4) state.current.mp4 = data.mp4; renderDownloads();
    if (data.videoStatus === 'processing') { notice('The WebM is saved. MP4 conversion is running.', true); pollPodcastVideo(state.current.id); }
    else notice('The continuous take is ready to download.', true);
  } catch (error) { notice(`Cloud copy failed, but the Download finished video button still works: ${error.message}`); }
}
function maybeFinish() { if (state.ended && !state.playing && !state.sandboxPlaying && !state.screenVideoPlaying && !state.queue.length) finishRecording(); }
async function playScreenVideo(url) {
  const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = url;
  state.screenVideoElement = video; state.screenVideoPlaying = true;
  try { await video.play(); await new Promise(resolve => { video.addEventListener('ended', resolve, { once: true }); video.addEventListener('error', resolve, { once: true }); }); }
  catch (error) { notice(`Desktop action playback failed: ${error.message || error}`); }
  finally { state.screenVideoPlaying = false; if (state.screenVideoElement === video) state.screenVideoElement = null; maybeFinish(); }
}
function waitForTail(element, leadSeconds = .28) {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; element.removeEventListener('timeupdate', check); element.removeEventListener('ended', finish); resolve(); };
    const check = () => { if (Number.isFinite(element.duration) && element.duration - element.currentTime <= leadSeconds) finish(); };
    element.addEventListener('timeupdate', check); element.addEventListener('ended', finish, { once: true }); check();
  });
}
async function playSpeechEvent(event) {
  const element = state.speechElements[event.role] || state.speechElements.host;
  state.audioElement = element; state.speaker = event.role; state.caption = event.text; state.captionCues = timedSubtitleCues(event.text, 1); state.captionElement = element; state.captionStarted = performance.now();
  const playback = playToEnd(element, event.audio);
  try { await api(`/api/episodes/${state.current.id}/ack`, { method: 'POST', body: JSON.stringify({ eventId: event.id }) }); } catch (error) { notice(error.message); }
  await waitForTail(element);
  let overlap = null;
  const next = state.queue[0];
  if (next && next.role !== event.role && !state.ended) {
    state.queue.shift();
    overlap = playSpeechEvent(next);
  }
  await playback;
  if (overlap) await overlap;
  if (state.speaker === event.role) { state.speaker = null; state.caption = ''; state.amplitude = 0; }
}
async function playQueue() {
  if (state.playing) return; state.playing = true;
  while (state.queue.length) {
    const event = state.queue.shift();
    try { await playSpeechEvent(event); }
    catch (error) {
      if (state.ended && error?.name === 'AbortError') break;
      if (playbackBlocked(error)) { state.queue.unshift(event); showAudioGate(); break; }
      notice(`Audio playback failed: ${error.message || error}`);
    }
  }
  state.playing = false; state.speaker = null; state.caption = ''; state.amplitude = 0; drawStage(); maybeFinish();
}
function stopLocalPlayback() {
  state.ended = true; state.queue = []; state.pendingSandboxAudio = null; state.playing = false; state.sandboxPlaying = false; state.screenVideoPlaying = false; if (state.screenVideoElement) { state.screenVideoElement.pause(); state.screenVideoElement = null; }
  for (const [element, cancel] of state.mediaCancels) { cancel(); element.pause(); element.removeAttribute('src'); element.load(); }
  state.mediaCancels.clear(); state.speaker = null; state.caption = ''; state.amplitude = 0; $('#enableAudio').classList.add('hidden'); drawStage();
}
async function restartPodcast(id) {
  const audioUnlock = unlockAudio();
  const restarted = await api(`/api/episodes/${id}/restart`, { method: 'POST' });
  await refreshMe(); await refresh(); await openStudio(restarted.id); await audioUnlock;
  $('#startEpisode').click();
}
async function restartExplainer(id) {
  const restarted = await api(`/api/explainers/${id}/restart`, { method: 'POST' });
  await refreshMe(); await refresh();
  if (restarted.authRequired) { openExplainerDialog(restarted); notice('Enter the credentials again to restart this explainer.'); return; }
  await api(`/api/explainers/${restarted.id}/start`, { method: 'POST' });
  await refreshMe(); await refresh(); navigate('explainers'); scheduleExplainerPoll(); notice('The explainer restarted with the same brief.', true);
}
function loadImage(url) { return new Promise(resolve => { if (!url) return resolve(null); const img = new Image(); img.onload = () => resolve(img); img.onerror = () => resolve(null); img.src = url; }); }
function rounded(ctx,x,y,w,h,r){ctx.beginPath();ctx.roundRect(x,y,w,h,r)}
function wrap(ctx,text,x,y,maxWidth,lineHeight,maxLines=12){const words=String(text||'').split(/\s+/);let line='',count=0;for(const word of words){const test=line ? `${line} ${word}` : word;if(ctx.measureText(test).width>maxWidth && line){ctx.fillText(line,x,y+count*lineHeight);count++;line=word;if(count>=maxLines)break}else line=test}if(count<maxLines)ctx.fillText(line,x,y+count*lineHeight);return count+1}
function captionLines(ctx,text,maxWidth,maxLines=3){const words=String(text||'').split(/\s+/),lines=[];let line='';for(const word of words){const next=line?`${line} ${word}`:word;if(ctx.measureText(next).width>maxWidth&&line){lines.push(line);line=word;if(lines.length===maxLines-1)break}else line=next}if(line&&lines.length<maxLines)lines.push(line);return lines}
// Advance through phrase cues as the speech audio plays; cues are timed on a 0–1 scale of the clip.
function liveCaptionText(){if(!state.captionCues?.length)return state.caption;const element=state.captionElement,duration=element?.duration;const progress=Number.isFinite(duration)&&duration>0?element.currentTime/duration:Math.min(.999,(performance.now()-state.captionStarted)/1000/Math.max(1.5,state.caption.split(/\s+/).length/2.6));return cueAt(state.captionCues,progress)?.text||''}
function drawCaption(ctx){if(!state.caption)return;const text=liveCaptionText();if(!text)return;ctx.save();const style=state.current?.settings?.captionStyle||'studio';ctx.textAlign='center';ctx.font=style==='bold'?'800 31px Arial':style==='minimal'?'600 26px Arial':'600 25px Arial';const lines=captionLines(ctx,text,style==='bold'?920:1000,2);const lineHeight=style==='bold'?39:34,boxHeight=lines.length*lineHeight+26,y=650-boxHeight;if(style==='studio'){ctx.fillStyle='#061013dc';rounded(ctx,110,y,1060,boxHeight,12);ctx.fill()}ctx.lineJoin='round';ctx.lineWidth=style==='bold'?8:style==='minimal'?5:0;ctx.strokeStyle='#061013';ctx.fillStyle=style==='bold'?'#80ded1':'#f4faf7';lines.forEach((line,index)=>{const yy=y+31+index*lineHeight;if(ctx.lineWidth)ctx.strokeText(line,640,yy);ctx.fillText(line,640,yy)});ctx.restore()}
function drawStage() {
  const canvas=$('#stage'),ctx=canvas.getContext('2d');if(!ctx)return;const W=canvas.width,H=canvas.height,s=W/1280;ctx.save();ctx.scale(s,s);const bg=state.current?.settings.background||'#101c24',accent=state.current?.settings.accent||'#80ded1';ctx.fillStyle=bg;ctx.fillRect(0,0,1280,720);
  const gradient=ctx.createRadialGradient(640,350,10,640,350,800);gradient.addColorStop(0,'#26545044');gradient.addColorStop(1,'#00000000');ctx.fillStyle=gradient;ctx.fillRect(0,0,1280,720);
  ctx.fillStyle=accent;ctx.font='bold 13px Arial';ctx.letterSpacing='3px';ctx.fillText('THE SALES FORGE',51,48);ctx.letterSpacing='0px';ctx.fillStyle='#bbd2cc';ctx.font='14px Arial';ctx.fillText((state.current?.outline.subject||'LIVE PODCAST').slice(0,105),51,81);
  const active=state.screen.type!=='idle';const stage=state.current?.settings.layout==='stage';const glow=state.current?.settings.glowStrength||1;
  const roles=castRoles(state.current||{});const n=roles.length;
  roles.forEach((role,i)=>{let x,y,r;
    if(!active){r=n<=2?150:n===3?112:n===4?92:78;x=n<=2?(i===0?390:890):1280/(n+1)*(i+1);y=310}
    else if(stage){r=Math.min(93,Math.floor(470/n/2.7));x=180;y=n<=2?(i===0?252:485):130+(470/(n-1||1))*i}
    else{r=n<=2?100:Math.min(80,Math.floor(1280/(n+1)/2.8));x=n<=2?(i===0?320:960):1280/(n+1)*(i+1);y=225}
    drawPersona(ctx,episodePerson(state.current,role),roleLabel(role),state.roleImages[role],x,y,r,state.speaker===role,roleAccent(state.current?.settings,role),glow)});
  if(active){const w=Math.round(1280*(state.current?.settings.paneWidth||66)/100),x=stage?1280-w-55:(1280-w)/2,y=stage?116:405,h=stage?500:235;ctx.fillStyle='#10242b';rounded(ctx,x,y,w,h,16);ctx.fill();ctx.strokeStyle='#487068';ctx.lineWidth=2;ctx.stroke();ctx.fillStyle=accent;ctx.font='bold 13px Arial';ctx.fillText((state.screen.title||'SANDBOX').slice(0,70),x+22,y+31);ctx.fillStyle='#a9c8c2';ctx.font='13px Arial';const visual=state.screenVideoElement&&state.screenVideoElement.readyState>=2?state.screenVideoElement:state.screenImage&&state.screen.image?state.screenImage:null;if(visual){try{const maxW=w-40,maxH=h-67,scale=Math.min(maxW/visual.videoWidth||maxW/visual.width,maxH/visual.videoHeight||maxH/visual.height),vw=visual.videoWidth||visual.width,vh=visual.videoHeight||visual.height,iw=vw*scale,ih=vh*scale;ctx.drawImage(visual,x+20+(maxW-iw)/2,y+49+(maxH-ih)/2,iw,ih)}catch{}}else wrap(ctx,state.screen.content||'Working…',x+22,y+67,w-44,21,Math.floor((h-65)/21));}
  drawCaption(ctx);ctx.fillStyle='#789b97';ctx.font='11px Arial';ctx.fillText('UNSCRIPTED · ONE CONTINUOUS TAKE',52,678);ctx.fillStyle='#ef8074';ctx.beginPath();ctx.arc(1179,44,5,0,Math.PI*2);ctx.fill();ctx.fillStyle='#b8d7cf';ctx.fillText('REC',1193,48);ctx.restore();
}
function drawPersona(ctx,p,role,img,x,y,r,speaking,color,glow=1){const power=speaking?Math.min(1,state.amplitude*4+.12):0;ctx.save();ctx.shadowColor=color;ctx.shadowBlur=speaking?(26+power*90)*glow:0;ctx.beginPath();ctx.arc(x,y,r+5+power*7,0,Math.PI*2);ctx.strokeStyle=color;ctx.globalAlpha=speaking?.5+power*.5:.25;ctx.lineWidth=(speaking?5+power*7:3)*glow;ctx.stroke();ctx.restore();ctx.save();ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.clip();if(img)ctx.drawImage(img,x-r,y-r,r*2,r*2);else{ctx.fillStyle=color;ctx.fillRect(x-r,y-r,r*2,r*2);ctx.fillStyle='#173038';ctx.font=`bold ${r}px Arial`;ctx.textAlign='center';ctx.fillText((p?.name||'?')[0].toUpperCase(),x,y+r*.35)}ctx.restore();ctx.fillStyle='#f1f5f1';ctx.font='bold 19px Arial';ctx.textAlign='center';ctx.fillText((p?.name||role).slice(0,24),x,y+r+35);ctx.fillStyle=color;ctx.font='bold 10px Arial';ctx.letterSpacing='2px';ctx.fillText(role,x,y+r+54);ctx.letterSpacing='0px';ctx.textAlign='left'}
function tick(){if(state.recorder?.state!=='recording')return;if(state.analyser&&state.speaker){const data=new Uint8Array(state.analyser.frequencyBinCount);state.analyser.getByteFrequencyData(data);state.amplitude=data.reduce((a,b)=>a+b,0)/data.length/255}else state.amplitude*=.8;drawStage();const elapsed=Math.floor((Date.now()-state.startTime)/1000);$('#stageTimer').textContent=`${String(Math.floor(elapsed/60)).padStart(2,'0')}:${String(elapsed%60).padStart(2,'0')}`;requestAnimationFrame(tick)}

function openExplainerDialog(item = null) {
  const form = $('#explainerForm'); form.reset(); form.dataset.explainerId = item?.id || '';
  if (item) {
    for (const name of ['title','url','brief','voice','captionStyle','loginUrl','usernameSelector','passwordSelector','submitSelector']) {
      if (form.elements[name] && item[name] != null) form.elements[name].value = item[name];
    }
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
  for (const name of ['username','password']) form.elements[name].required = form.elements.authRequired.checked;
  updateSubtitlePreview();
  $('#explainerDialog').showModal();
}

function updateSubtitlePreview() {
  const form = $('#explainerForm'), preview = $('#subtitlePreview'), sample = preview.querySelector('span');
  const style = form.elements.captionStyle.value, font = form.elements.captionFont.value, position = form.elements.captionPosition.value;
  preview.dataset.style = style; preview.dataset.font = font; preview.dataset.position = position;
  sample.style.fontSize = `${form.elements.captionSize.value}px`;
  sample.style.color = form.elements.captionTextColor.value;
  sample.style.backgroundColor = style === 'minimal' || style === 'bold' ? 'transparent' : `${form.elements.captionBackgroundColor.value}bb`;
  sample.style.opacity = form.elements.captionsEnabled.checked ? '1' : '.25';
  $('#captionSizeValue').textContent = `${form.elements.captionSize.value} px`;
  $('#captionWordsValue').textContent = `${form.elements.captionWords.value} words`;
}

async function saveExplainerForm(event) {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('[type=submit]'); button.disabled = true;
  let item = null;
  try {
    const authRequired = form.elements.authRequired.checked;
    if (authRequired && (!form.elements.username.value || !form.elements.password.value)) throw new Error('Enter the login username and password.');
    const existing = state.explainers.find(item => item.id === form.dataset.explainerId);
    item = existing || await api('/api/explainers', { method: 'POST', body: JSON.stringify({
      title: form.elements.title.value, url: form.elements.url.value, brief: form.elements.brief.value,
      authRequired, voice: form.elements.voice.value, captionStyle: form.elements.captionStyle.value,
      captionOptions: { enabled: form.elements.captionsEnabled.checked, font: form.elements.captionFont.value, size: +form.elements.captionSize.value, textColor: form.elements.captionTextColor.value, backgroundColor: form.elements.captionBackgroundColor.value, position: form.elements.captionPosition.value, wordsPerCue: +form.elements.captionWords.value },
      loginUrl: form.elements.loginUrl.value,
      usernameSelector: form.elements.usernameSelector.value, passwordSelector: form.elements.passwordSelector.value,
      submitSelector: form.elements.submitSelector.value,
      reviewPlan: form.elements.reviewPlan.checked,
      effects: { zoom: form.elements.effectZoom.checked, highlight: form.elements.effectHighlight.checked },
      branding: { intro: form.elements.brandIntro.checked, outro: form.elements.brandOutro.checked }
    }) });
    if (authRequired) {
      button.textContent = 'Signing in privately…';
      await api(`/api/explainers/${item.id}/prepare`, { method: 'POST', body: JSON.stringify({
        username: form.elements.username.value, password: form.elements.password.value,
        loginUrl: form.elements.loginUrl.value, usernameSelector: form.elements.usernameSelector.value,
        passwordSelector: form.elements.passwordSelector.value, submitSelector: form.elements.submitSelector.value
      }) });
      form.elements.password.value = '';
    }
    await beginExplainerProduction(item, form.elements.reviewPlan.checked, button);
    $('#explainerDialog').close();
  } catch (error) {
    if (item?.id && form.elements.authRequired.checked) {
      form.dataset.explainerId = item.id;
      $('#explainerManualDesktop').classList.remove('hidden');
      notice(`${error.message} Finish the sign-in in the live desktop.`);
    } else notice(error.message);
  }
  finally { button.disabled = false; button.textContent = 'Create and generate'; }
}

// After sign-in: either draft a plan for review (free) or start recording straight away.
async function beginExplainerProduction(item, reviewPlan, button = null) {
  if (reviewPlan) {
    if (button) button.textContent = 'Drafting scene plan…';
    await api(`/api/explainers/${item.id}/plan`, { method: 'POST' });
    state.awaitingPlan.add(item.id);
    await refresh(); navigate('explainers'); scheduleExplainerPoll();
    notice('Drafting a scene plan. You can review and edit it before anything is recorded.', true);
    return;
  }
  if (button) button.textContent = 'Starting workflow…';
  await api(`/api/explainers/${item.id}/start`, { method: 'POST' });
  await refreshMe(); await refresh(); navigate('explainers'); scheduleExplainerPoll();
  notice('The explainer is in production.', true);
}
function scheduleExplainerPoll() {
  clearTimeout(state.explainerPoll);
  if (!state.explainers.some(item => ['queued','running','planning','rendering'].includes(item.status))) return;
  state.explainerPoll = setTimeout(async () => {
    try {
      await refresh(); scheduleExplainerPoll();
      const ready = state.explainers.find(item => item.status === 'awaiting_approval' && state.awaitingPlan.has(item.id));
      if (ready && !document.querySelector('dialog[open]')) { state.awaitingPlan.delete(ready.id); openPlanDialog(ready); }
    } catch (error) { notice(error.message); }
  }, 4000);
}
function planSceneMarkup(scene = {}, editable = true) {
  return `<li class="plan-scene"><div class="form-row"><label>Title<input name="title" maxlength="60" value="${esc(scene.title || '')}"></label>${editable ? '<button type="button" class="icon-button" data-remove-scene title="Remove scene">×</button>' : ''}</div><label>What happens<input name="goal" maxlength="240" value="${esc(scene.goal || '')}"></label><label>Narration<textarea name="narration" rows="2" maxlength="360">${esc(scene.narration || scene.text || '')}</textarea></label></li>`;
}
function openPlanDialog(item) {
  const form = $('#planForm'); form.dataset.explainerId = item.id;
  $('#planScenes').innerHTML = (item.plan?.scenes || []).map(scene => planSceneMarkup(scene)).join('');
  $('#planDialog').showModal();
}
function readPlanScenes() {
  return [...$('#planScenes').querySelectorAll('.plan-scene')].map(row => ({ title: row.querySelector('[name=title]').value, goal: row.querySelector('[name=goal]').value, narration: row.querySelector('[name=narration]').value }));
}
async function approvePlan(event) {
  event.preventDefault();
  const form = event.currentTarget, id = form.dataset.explainerId, button = form.querySelector('[type=submit]'); button.disabled = true;
  try {
    await api(`/api/explainers/${id}/plan`, { method: 'PUT', body: JSON.stringify({ scenes: readPlanScenes() }) });
    await api(`/api/explainers/${id}/start`, { method: 'POST' });
    $('#planDialog').close(); await refreshMe(); await refresh(); scheduleExplainerPoll();
    notice('Plan approved. The explainer is recording.', true);
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
}
function openRerenderDialog(item) {
  const form = $('#rerenderForm'); form.dataset.explainerId = item.id;
  form.elements.voice.value = item.voice || 'coral'; form.elements.captionStyle.value = item.captionStyle || 'studio'; form.elements.captionsEnabled.checked = item.captionOptions?.enabled !== false;
  $('#rerenderScenes').innerHTML = item.scenes.map(scene => `<li class="plan-scene"><strong>${esc(scene.title || 'Scene')}</strong><label>Narration<textarea name="text" rows="2" maxlength="400">${esc(scene.text)}</textarea></label></li>`).join('');
  $('#rerenderDialog').showModal();
}
async function submitRerender(event) {
  event.preventDefault();
  const form = event.currentTarget, id = form.dataset.explainerId, button = form.querySelector('[type=submit]'); button.disabled = true;
  const item = state.explainers.find(entry => entry.id === id);
  try {
    const scenes = [...$('#rerenderScenes').querySelectorAll('textarea')].map(area => ({ text: area.value }));
    await api(`/api/explainers/${id}/rerender`, { method: 'POST', body: JSON.stringify({ scenes, voice: form.elements.voice.value, captionStyle: form.elements.captionStyle.value, captionOptions: { ...(item?.captionOptions || {}), enabled: form.elements.captionsEnabled.checked } }) });
    $('#rerenderDialog').close(); await refreshMe(); await refresh(); scheduleExplainerPoll();
    notice('Re-rendering with the new narration. The current video stays available until it finishes.', true);
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
}
async function openBrandDialog() {
  const form = $('#brandForm'); form.reset();
  const kit = await api('/api/brand').catch(() => ({}));
  for (const name of ['name','outroText','callToAction']) form.elements[name].value = kit[name] || '';
  form.elements.primaryColor.value = kit.primaryColor || '#101c24'; form.elements.accentColor.value = kit.accentColor || '#80ded1';
  form._logo = kit.logo || '';
  $('#brandLogoPreview').innerHTML = form._logo ? `<img src="${esc(form._logo)}" alt="Current logo">` : 'No logo';
  $('#brandDialog').showModal();
}
async function saveBrand(event) {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('[type=submit]'); button.disabled = true;
  try {
    const file = form.elements.logoFile.files[0];
    if (file) form._logo = (await uploadFile(file, 'logo')).asset;
    await api('/api/brand', { method: 'PUT', body: JSON.stringify({ name: form.elements.name.value, logo: form._logo, primaryColor: form.elements.primaryColor.value, accentColor: form.elements.accentColor.value, outroText: form.elements.outroText.value, callToAction: form.elements.callToAction.value }) });
    $('#brandDialog').close(); notice('Brand kit saved. New videos will use it.', true);
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
}

async function refreshMe() {
  const me = await api('/api/auth/me'); state.account = me.account; renderAccount(); return me;
}

async function checkout(plan) {
  if (!state.clerk?.user) { state.clerk?.openSignIn({ redirectUrl: window.location.href }); return; }
  const result = await api('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ plan }) });
  window.location.assign(result.url);
}

async function openPortal() {
  const result = await api('/api/billing/portal', { method: 'POST' });
  window.location.assign(result.url);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('sales-forge-theme', theme);
}

async function bootstrap() {
  const response = await fetch('/api/config');
  state.config = await response.json();
  renderPlans();
  if (!state.config.clerkPublishableKey) throw new Error('Clerk is not configured.');
  state.clerk = await window.createSalesForgeClerk(state.config.clerkPublishableKey);
  const initialUser = state.clerk.user?.id || null;
  state.clerk.addListener(({ user }) => { if ((user?.id || null) !== initialUser) window.location.reload(); });
  if (!state.clerk.user) return;
  let me = await refreshMe();
  if (new URLSearchParams(location.search).get('billing') === 'success' && !['active','trialing'].includes(me.account.subscriptionStatus)) {
    for (let i = 0; i < 12 && !['active','trialing'].includes(me.account.subscriptionStatus); i++) {
      await new Promise(resolve => setTimeout(resolve, 1500)); me = await refreshMe();
    }
  }
  $('#publicGate').classList.add('hidden');
  if (!['active','trialing'].includes(me.account.subscriptionStatus)) { $('#subscriptionGate').classList.remove('hidden'); return; }
  $('#subscriptionGate').classList.add('hidden'); $('#workspace').classList.remove('hidden');
  state.clerk.mountUserButton($('#clerkUserButton'), { appearance: { elements: { avatarBox: { width: '32px', height: '32px' } } } });
  await refresh(); renderPlans(); scheduleExplainerPoll();
  if (new URLSearchParams(location.search).get('billing') === 'success') { history.replaceState({}, '', '/'); notice('Payment confirmed. Monthly credits are ready.', true); }
  const youtube = new URLSearchParams(location.search).get('youtube');
  if (youtube) { history.replaceState({}, '', '/'); notice(youtube === 'connected' ? 'YouTube connected. Open Publish on any finished video to upload it.' : 'YouTube was not connected. Please try again.', youtube === 'connected'); }
}

$$('[data-view]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.view)));
['#newEpisodeTop','#newEpisodeHero','#newEpisodeButton'].forEach(s=>$(s).addEventListener('click',openEpisodeDialog));
['#newPersonaHero','#newPersonaButton'].filter(s=>$(s)).forEach(s=>$(s).addEventListener('click',()=>openPersona()));
['#newExplainerHero','#newExplainerButton'].forEach(s=>$(s).addEventListener('click',openExplainerDialog));
$$('.close-dialog').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
$('#personaForm').addEventListener('submit',savePersona);$('#episodeForm').addEventListener('submit',saveEpisode);
$('#explainerForm').addEventListener('submit',saveExplainerForm);
$('#openExplainerDesktop').addEventListener('click',async()=>{const id=$('#explainerForm').dataset.explainerId;if(!id)return notice('Create the explainer first.');const popup=window.open('about:blank','_blank');if(popup)popup.opener=null;try{const{liveUrl}=await api(`/api/explainers/${id}/desktop`);if(popup)popup.location=liveUrl;else window.open(liveUrl,'_blank','noopener')}catch(error){popup?.close();notice(error.message)}});
$('#explainerDesktopReady').addEventListener('click',async()=>{const form=$('#explainerForm'),id=form.dataset.explainerId,button=$('#explainerDesktopReady');if(!id)return notice('Create the explainer first.');button.disabled=true;try{await api(`/api/explainers/${id}/desktop-ready`,{method:'POST'});form.elements.password.value='';await beginExplainerProduction({id},form.elements.reviewPlan.checked);$('#explainerDialog').close()}catch(error){notice(error.message)}finally{button.disabled=false}});
$('#explainerForm').elements.authRequired.addEventListener('change',event=>{$('#explainerCredentials').classList.toggle('hidden',!event.target.checked);for(const name of ['username','password'])$('#explainerForm').elements[name].required=event.target.checked});
for (const name of ['captionsEnabled','captionStyle','captionPosition','captionFont','captionSize','captionTextColor','captionBackgroundColor','captionWords']) $('#explainerForm').elements[name].addEventListener('input',updateSubtitlePreview);
$('#personaForm').elements.imageFile.addEventListener('change',event=>{const file=event.target.files[0];if(file)$('#imagePreview').innerHTML=`<img src="${URL.createObjectURL(file)}" alt="Image preview">`});
$('#personaForm').elements.knowledgeFiles.addEventListener('change', renderKnowledgeList);
$('#previewVoice').addEventListener('click', previewVoice);
$('#chatForm').addEventListener('submit', sendChat);
$('#personaTemplate').addEventListener('change', event => {
  const template = state.templates?.find(entry => entry.id === event.target.value), form = $('#personaForm');
  if (!template) return;
  for (const key of ['name','systemPrompt','voiceStyle']) form.elements[key].value = template[key];
  form.elements.voice.value = template.voice;
});
$('#addKnowledgeUrl').addEventListener('click', async () => {
  const form = $('#personaForm'), button = $('#addKnowledgeUrl'), target = form.elements.knowledgeUrl.value.trim();
  if (!target) return notice('Paste a public web page address first.');
  button.disabled = true; button.textContent = 'Reading…';
  try { const page = await api('/api/extract-url', { method: 'POST', body: JSON.stringify({ url: target }) }); form._knowledge.push(page); form.elements.knowledgeUrl.value = ''; renderKnowledgeList(); notice(`Added “${page.name}”. Save the persona to index it.`, true); }
  catch (error) { notice(error.message); } finally { button.disabled = false; button.textContent = 'Add page'; }
});
document.addEventListener('click', event => {
  const remove = event.target.closest('[data-remove-knowledge]'); if (remove) { $('#personaForm')._knowledge.splice(Number(remove.dataset.removeKnowledge), 1); renderKnowledgeList(); }
  const chat = event.target.closest('button[data-chat]'); if (chat) openChat(person(chat.dataset.chat));
});
$('#speechProvider').addEventListener('change',()=>{updateVoiceSuggestions();$('#voiceSelect').value=state.config?.providers.voices?.[$('#speechProvider').value]?.[0]||''});
$('#episodeForm').elements.interjectProbability.addEventListener('input',event=>{$('#interjectValue').textContent=`${event.target.value}%`});
$('#episodeForm').elements.maxInterruptions.addEventListener('input',event=>{$('#maxInterruptionsValue').textContent=`${event.target.value} per episode`});
$('#episodeForm').elements.musicVolume.addEventListener('input',event=>{$('#musicVolumeValue').textContent=`${event.target.value}%`});
$('#episodeForm').elements.paneWidth.addEventListener('input',event=>{$('#paneValue').textContent=`${event.target.value}%`});
$('#episodeForm').elements.authRequired.addEventListener('change',event=>{$('#episodeCredentials').classList.toggle('hidden',!event.target.checked);for(const name of ['demoUsername','demoPassword'])$('#episodeForm').elements[name].required=event.target.checked});
document.addEventListener('click',event=>{const ep=event.target.closest('[data-episode]');if(ep&&!event.target.closest('button,a'))openStudio(ep.dataset.episode).catch(e=>notice(e.message));const edit=event.target.closest('button[data-edit]');if(edit)openPersona(person(edit.dataset.edit))});
document.addEventListener('click', event => { const retry = event.target.closest('[data-retry-explainer]'); if (retry) openExplainerDialog(state.explainers.find(item => item.id === retry.dataset.retryExplainer)); });
document.addEventListener('click', event => { const podcast = event.target.closest('[data-restart-episode]'); if (podcast) restartPodcast(podcast.dataset.restartEpisode).catch(error => notice(error.message)); const explainer = event.target.closest('[data-restart-explainer]'); if (explainer) restartExplainer(explainer.dataset.restartExplainer).catch(error => notice(error.message)); });
$('#backToEpisodes').addEventListener('click',()=>navigate('episodes'));
$('#planForm').addEventListener('submit', approvePlan);
$('#rerenderForm').addEventListener('submit', submitRerender);
$('#brandForm').addEventListener('submit', saveBrand);
$('#addPlanScene').addEventListener('click', () => $('#planScenes').insertAdjacentHTML('beforeend', planSceneMarkup()));
$('#redraftPlan').addEventListener('click', async () => { const id = $('#planForm').dataset.explainerId; try { await api(`/api/explainers/${id}/plan`, { method: 'POST' }); state.awaitingPlan.add(id); $('#planDialog').close(); await refresh(); scheduleExplainerPoll(); notice('Redrafting the scene plan…', true); } catch (error) { notice(error.message); } });
$('#brandForm').elements.logoFile.addEventListener('change', event => { const file = event.target.files[0]; if (file) $('#brandLogoPreview').innerHTML = `<img src="${URL.createObjectURL(file)}" alt="Logo preview">`; });
document.addEventListener('click', event => {
  if (event.target.closest('[data-remove-scene]')) event.target.closest('.plan-scene').remove();
  const review = event.target.closest('[data-review-plan]'); if (review) openPlanDialog(state.explainers.find(item => item.id === review.dataset.reviewPlan));
  const rerender = event.target.closest('[data-rerender-explainer]'); if (rerender) openRerenderDialog(state.explainers.find(item => item.id === rerender.dataset.rerenderExplainer));
  if (event.target.closest('[data-open-brand]')) openBrandDialog().catch(error => notice(error.message));
  const helpers = { api, notice, refreshMe, costs: state.config?.costs };
  const publishExplainer = event.target.closest('[data-publish-explainer]'); if (publishExplainer) openPublishDialog('explainer', state.explainers.find(item => item.id === publishExplainer.dataset.publishExplainer), helpers).catch(error => notice(error.message));
  if (event.target.closest('[data-publish-episode]')) openPublishDialog('podcast', state.current, helpers).catch(error => notice(error.message));
});
$('#fullscreenStage').addEventListener('click',()=>$('#stage').requestFullscreen());
$$('.side-tab').forEach(b=>b.addEventListener('click',()=>{$$('.side-tab').forEach(x=>x.classList.toggle('active',x===b));$('#transcriptPane').classList.toggle('hidden',b.dataset.side!=='transcript');$('#activityPane').classList.toggle('hidden',b.dataset.side!=='activity')}));
$('#startEpisode').addEventListener('click',async()=>{const button=$('#startEpisode');try{const audioUnlock=unlockAudio();for(const p of [episodePerson(state.current,'host'),episodePerson(state.current,'guest')]){if(!state.config.providers.ready.models[p.modelProvider||'gateway']||!state.config.providers.ready.speech[p.speechProvider||'gateway'])throw new Error(`Configure ${p.name}'s model and speech providers before starting.`)}const credentials=await credentialsForCurrentEpisode();if(state.current.settings.demo?.authRequired&&!credentials)return;button.disabled=true;button.textContent=credentials?'Signing in securely…':'Preparing…';if(credentials&&!credentials.manualPrepared){await api(`/api/episodes/${state.current.id}/prepare`,{method:'POST',body:JSON.stringify({credentials})});state.credentials.delete(state.current.id)}await audioUnlock;await startRecording();button.classList.add('hidden');await api(`/api/episodes/${state.current.id}/start`,{method:'POST'});setStatus('preparing');await refreshMe()}catch(error){notice(error.message);if(state.recorder?.state==='recording')state.recorder.stop()}finally{button.disabled=false;button.textContent='Start recording'}});
$('#enableAudio').addEventListener('click',async()=>{const button=$('#enableAudio');button.disabled=true;try{await unlockAudio();if(state.audioContext.state==='suspended')await state.audioContext.resume();button.classList.add('hidden');const pending=state.pendingSandboxAudio;state.pendingSandboxAudio=null;if(pending)playSandboxAudio(pending);playQueue()}catch(error){notice(`Audio could not be enabled: ${error.message || error}`)}finally{button.disabled=false}});
$('#restartEpisode').addEventListener('click',()=>restartPodcast(state.current.id).catch(error=>notice(error.message)));
$('#resumeEpisode').addEventListener('click', async () => {
  const button = $('#resumeEpisode'); button.disabled = true;
  try {
    const audioUnlock = unlockAudio();
    let credentials = null;
    if (state.current.settings.demo?.authRequired && !state.current.guestDemoDone) { credentials = await credentialsForCurrentEpisode(); if (!credentials) return; }
    await api(`/api/episodes/${state.current.id}/resume`, { method: 'POST', body: JSON.stringify({ credentials }) });
    state.credentials.delete(state.current.id);
    await audioUnlock; await openStudio(state.current.id); await startRecording(); await refreshMe();
    notice('Resuming from the last turn. The conversation so far is kept.', true);
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
});
$('#renderEpisode').addEventListener('click', async () => {
  const button = $('#renderEpisode'); button.disabled = true;
  try { await api(`/api/episodes/${state.current.id}/render`, { method: 'POST' }); state.current.videoStatus = 'processing'; state.current.videoError = null; setStatus(state.current.status); renderStudioError(); renderDownloads(); pollPodcastVideo(state.current.id); await refreshMe(); }
  catch (error) { notice(error.message); } finally { button.disabled = false; }
});
$('#stopEpisode').addEventListener('click',async()=>{const button=$('#stopEpisode');button.disabled=true;try{await api(`/api/episodes/${state.current.id}/stop`,{method:'POST'});stopLocalPlayback();setStatus('stopped');await finishRecording();await refreshMe();await refresh();notice('Episode stopped. The video is ready below.',true)}catch(error){notice(error.message)}finally{button.disabled=false}});
document.addEventListener('click', event => { const button = event.target.closest('[data-plan]'); if (!button) return; if (button.dataset.context === 'workspace') openPortal().catch(error => notice(error.message)); else checkout(button.dataset.plan).catch(error => notice(error.message)); });
$('#signInButton').addEventListener('click',()=>state.clerk?.openSignIn({ redirectUrl: window.location.href }));
$('#choosePlanButton').addEventListener('click',()=>$('#pricing').scrollIntoView({ behavior:'smooth' }));
$('#watchWorkflowButton').addEventListener('click',()=>$('#workflow').scrollIntoView({ behavior:'smooth' }));
$('#gateSignOut').addEventListener('click',()=>state.clerk?.signOut({ redirectUrl:'/' }));
$('#manageBilling').addEventListener('click',()=>openPortal().catch(error=>notice(error.message)));
$('#themeToggle').addEventListener('click',()=>applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
setInterval(()=>$('#clock').textContent=new Date().toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}),1000);
applyTheme(localStorage.getItem('sales-forge-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
bootstrap().catch(e=>notice(e.message));
