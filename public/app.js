const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = { personas: [], episodes: [], explainers: [], config: null, account: null, clerk: null, current: null, eventSource: null, pollTimer: null, explainerPoll: null, recorder: null, recorderChunks: [], audioContext: null, audioElement: null, sandboxAudioElement: null, sandboxPlaying: false, analyser: null, audioDestination: null, queue: [], playing: false, screen: { type: 'idle', title: 'The stage is ready', content: '' }, speaker: null, caption: '', amplitude: 0, startTime: 0, hostImage: null, guestImage: null, screenImage: null, ended: false, seen: new Set(), credentials: new Map(), localVideoUrl: null };

async function api(path, options = {}) {
  const token = await state.clerk?.session?.getToken().catch(() => null);
  const response = await fetch(path, { ...options, headers: { ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function notice(message, good = false) { const el = $('#notice'); el.textContent = message; el.classList.toggle('ok', good); el.classList.remove('hidden'); clearTimeout(notice.timer); notice.timer = setTimeout(() => el.classList.add('hidden'), 6000); }
async function refresh() { const [personas, episodes, explainers, config] = await Promise.all([api('/api/personas'), api('/api/episodes'), api('/api/explainers'), api('/api/config')]); state.personas = personas; state.episodes = episodes; state.explainers = explainers; state.config = config; render(); }
function person(id) { return state.personas.find(p => p.id === id); }
function episodePerson(episode, role) { return episode?.personas?.[role] || person(episode?.[`${role}Id`]); }
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
  $('#personaGrid').innerHTML = state.personas.length ? state.personas.map(p => `<article class="persona-card">${avatar(p,true)}<h3>${esc(p.name)}</h3><p>${esc(p.systemPrompt)}</p><div class="persona-card-foot"><span>${p.knowledge?.length || 0} knowledge files · ${esc(p.voice)}</span><button data-edit="${p.id}">Edit →</button></div></article>`).join('') : '<div class="empty"><strong>No personas yet</strong>Create a host and a guest to begin.</div>';
  $('#episodeList').innerHTML = state.episodes.length ? state.episodes.map(e => `<article class="episode-row" data-episode="${e.id}" role="button" tabindex="0"><div><div class="eyebrow">${shortDate(e.createdAt)}</div><h3>${esc(e.outline.subject)}</h3><p>${esc(episodePerson(e,'host')?.name || 'Host')} × ${esc(episodePerson(e,'guest')?.name || 'Guest')} · ${e.turns?.length || 0} spoken segments</p></div><div class="episode-row-right"><span class="tag ${esc(e.status)}">${esc(e.status)}</span><span class="card-arrow">↗</span></div></article>`).join('') : '<div class="empty"><strong>Nothing recorded yet</strong>Create an episode to start the archive.</div>';
  $('#explainerList').innerHTML = state.explainers.length ? state.explainers.map(e => `<article class="episode-row explainer-row"><div><div class="eyebrow">${shortDate(e.createdAt)} · ${esc(new URL(e.url).hostname)}</div><h3>${esc(e.title)}</h3><p>${esc(e.progress || e.brief)}</p></div><div class="episode-row-right"><span class="tag ${esc(e.status)}">${esc(e.status)}</span>${e.video ? `<a class="row-download" href="${esc(e.video)}" download>Download MP4</a><a class="row-download secondary" href="${esc(e.captions)}" download>Captions</a>` : ''}${e.status === 'draft' && e.authRequired ? `<button class="row-action" data-retry-explainer="${esc(e.id)}">Resume secure sign-in</button>` : ''}${e.error ? `<small class="row-error">${esc(e.error)}</small>` : ''}</div></article>`).join('') : '<div class="empty"><strong>No explainers yet</strong>Give the agent a URL and the workflow your customer needs to understand.</div>';
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
  if (existing) for (const key of ['name','systemPrompt','model']) form.elements[key].value = existing[key] || '';
  form._image = existing?.image || ''; form._knowledge = existing?.knowledge || [];
  $('#imagePreview').innerHTML = form._image ? `<img src="${esc(form._image)}" alt="Selected display image">` : 'No image selected';
  $('#knowledgeList').textContent = form._knowledge.map(k => k.name).join(' · ') || 'No knowledge files';
  $('#personaDialog').showModal();
}
function openEpisodeDialog() {
  if (state.personas.length < 2) { notice('Create two personas before making an episode.'); navigate('personas'); return; }
  $('#episodeForm').reset();
  $('#episodeCredentials').classList.add('hidden');
  for (const name of ['demoUsername','demoPassword']) $('#episodeForm').elements[name].required = false;
  const format = $('#episodeForm').elements.outputFormat;
  for (const option of format.options) option.disabled = !!state.config?.storage?.remoteAssets && option.value !== 'webm';
  if (state.config?.storage?.remoteAssets) format.value = 'webm';
  $('#interjectValue').textContent = '3%'; $('#paneValue').textContent = '66%';
  populateSelect($('#hostSelect'), state.personas.map(p => [p.id,p.name]), state.personas[0].id);
  populateSelect($('#guestSelect'), state.personas.map(p => [p.id,p.name]), state.personas[1].id);
  $('#episodeDialog').showModal();
}
function updateVoiceSuggestions() { const voices = state.config?.providers.voices?.[$('#speechProvider').value] || []; $('#voiceSuggestions').innerHTML = voices.map(voice => `<option value="${esc(voice)}"></option>`).join(''); }
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
    const knowledge = [...form._knowledge];
    for (const file of form.elements.knowledgeFiles.files) {
      if (file.size > 5_000_000) throw new Error(`${file.name} exceeds the 5 MB file limit.`);
      knowledge.push({ name: file.name, text: await extractFile(file) });
    }
    const data = { name: form.elements.name.value, systemPrompt: form.elements.systemPrompt.value, modelProvider: form.elements.modelProvider.value, model: form.elements.model.value, speechProvider: form.elements.speechProvider.value, voice: form.elements.voice.value, image, knowledge };
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
    const data = { hostId: form.elements.hostId.value, guestId: form.elements.guestId.value, outline: { subject: form.elements.subject.value, angle: form.elements.angle.value, points: form.elements.points.value }, settings: { layout: form.elements.layout.value, maxMinutes: +form.elements.maxMinutes.value, width, height, outputFormat: form.elements.outputFormat.value, accent: form.elements.accent.value, guestAccent: form.elements.guestAccent.value, background: form.elements.background.value, glowStrength: +form.elements.glowStrength.value, paneWidth: +form.elements.paneWidth.value, interjections: form.elements.interjections.checked, interjectProbability: +form.elements.interjectProbability.value / 100, hostTools: form.elements.hostTools.checked, requireGuestDemo: form.elements.requireGuestDemo.checked, demo: { url: form.elements.demoUrl.value, brief: form.elements.demoBrief.value, authRequired, usernameSelector: form.elements.usernameSelector.value, passwordSelector: form.elements.passwordSelector.value, submitSelector: form.elements.submitSelector.value } } };
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
  state.screen = { type: 'idle', title: 'The stage is ready', content: '' }; state.screenImage = null; state.speaker = null; state.caption = ''; state.amplitude = 0; state.queue = []; state.playing = false; state.seen = new Set(); state.ended = ['complete','stopped','failed','interrupted'].includes(state.current.status);
  state.hostImage = await loadImage(episodePerson(state.current,'host')?.image); state.guestImage = await loadImage(episodePerson(state.current,'guest')?.image);
  $('#studioTitle').textContent = state.current.outline.subject;
  $('#studioMeta').textContent = `${episodePerson(state.current,'host')?.name || 'Host'} × ${episodePerson(state.current,'guest')?.name || 'Guest'} · ${shortDate(state.current.createdAt)}`;
  $('#transcriptPane').innerHTML = ''; $('#activityPane').innerHTML = '';
  $('#startEpisode').classList.toggle('hidden', state.current.status !== 'draft');
  $('#stopEpisode').classList.toggle('hidden', !['running','preparing'].includes(state.current.status));
  setStatus(state.current.status);
  renderDownloads(); navigate('studio');
  for (const event of state.current.events) processEvent(event, true);
  drawStage();
  if (['running','preparing','draft'].includes(state.current.status) && state.config?.realtime === 'poll') {
    pollEpisode(id);
  } else if (['running','preparing','draft'].includes(state.current.status)) {
    state.eventSource = new EventSource(`/api/episodes/${id}/events`);
    state.eventSource.onmessage = e => processEvent(JSON.parse(e.data));
    state.eventSource.onerror = () => { if (!state.ended) notice('Live connection interrupted. Reconnecting…'); };
  }
}
async function pollEpisode(id) {
  if (state.current?.id !== id || state.ended) return;
  try {
    const fresh = await api(`/api/episodes/${id}`);
    for (const event of fresh.events || []) processEvent(event);
    state.current.video = fresh.video;
    state.current.mp4 = fresh.mp4;
    renderDownloads();
  } catch (cause) {
    if (!state.ended) notice(`Live update failed: ${cause.message}`);
  }
  if (state.current?.id === id && !state.ended) state.pollTimer = setTimeout(() => pollEpisode(id), 1000);
}
function setStatus(status) { $('#liveStatus').textContent = status.toUpperCase(); $('#liveStatus').className = `pill ${status}`; $('#stopEpisode').classList.toggle('hidden', !['running','preparing'].includes(status)); }
function renderDownloads() {
  const e = state.current; const transcript = new Blob([e.turns.map(t => `${t.role.toUpperCase()}: ${t.text}`).join('\n\n')], { type: 'text/plain' });
  const transcriptUrl = URL.createObjectURL(transcript);
  const stem = e.outline.subject.replace(/[^a-z0-9]/gi,'-').replace(/-+/g,'-').replace(/^-|-$/g,'') || 'podcast';
  const video = e.mp4 || e.video || state.localVideoUrl;
  $('#downloads').innerHTML = `${video ? `<a class="video-download" href="${esc(video)}" download="${esc(stem)}.${e.mp4 ? 'mp4' : 'webm'}">↓ Download finished video</a>` : ''}<a href="${transcriptUrl}" download="${esc(stem)}-transcript.txt">↓ Transcript</a><a href="/api/episodes/${e.id}" download="episode.json" target="_blank">Episode data ↗</a>${e.mp4 && e.video ? `<a href="${esc(e.video)}" download="${esc(stem)}.webm">↓ WebM copy</a>` : ''}`;
  const player = $('#reviewPlayer');
  player.classList.toggle('hidden', !video);
  if (video && player.dataset.source !== video) { player.dataset.source = video; player.src = video; }
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
    const close = () => { form.removeEventListener('submit', submit); dialog.removeEventListener('close', close); resolve(value); };
    form.addEventListener('submit', submit); dialog.addEventListener('close', close); dialog.showModal();
  });
}
function appendTranscript(role, text) { const pane = $('#transcriptPane'); pane.insertAdjacentHTML('beforeend', `<div class="transcript-item ${role}"><strong>${esc(role)} · LIVE</strong><p>${esc(text)}</p></div>`); pane.scrollTop = pane.scrollHeight; }
function appendActivity(title, content, assetUrl) { const pane = $('#activityPane'); const link = assetUrl?.startsWith('/assets/') ? `<br><a href="${esc(assetUrl)}" target="_blank" rel="noopener">Open artifact ↗</a>` : ''; pane.insertAdjacentHTML('beforeend', `<div class="activity-item"><strong>${esc(title)}</strong>${esc(content || '')}${link}</div>`); pane.scrollTop = pane.scrollHeight; }
function processEvent(event, history = false) {
  if (state.seen.has(event.id)) return; state.seen.add(event.id);
  if (event.type === 'status') {
    state.current.status = event.status; setStatus(event.status);
    if (event.error) notice(event.error);
    if (['complete','stopped','failed'].includes(event.status)) { state.ended = true; state.eventSource?.close(); maybeFinish(); }
  }
  if (event.type === 'speech') {
    state.current.turns.push({ role: event.role, text: event.text });
    appendTranscript(event.role, event.text);
    if (!history && !event.acknowledged) { state.queue.push(event); playQueue(); }
  }
  if (event.type === 'tool_start') { appendActivity(`Started ${event.tool}`, JSON.stringify(event.input).slice(0, 350)); state.screen = { type: 'working', title: `${event.tool} in progress`, content: 'Live sandbox activity…' }; }
  if (event.type === 'tool_output') { state.screen = event.screen || { type: 'terminal', title: event.tool, content: event.chunk }; }
  if (event.type === 'tool_end') { state.screen = event.screen; appendActivity(`${event.tool} finished`, event.screen?.content?.slice(0, 500), event.screen?.asset || event.screen?.image); if (event.screen?.image) loadImage(event.screen.image).then(img => { state.screenImage = img; drawStage(); }); if (!history && event.screen?.audio && state.sandboxAudioElement) { state.sandboxPlaying = true; state.sandboxAudioElement.src = event.screen.audio; state.sandboxAudioElement.play().catch(error => { state.sandboxPlaying = false; notice(`Sandbox sound failed: ${error.message}`); maybeFinish(); }); } }
  if (event.type === 'interrupt') appendActivity(`${event.by} interjected`, event.reason);
  if (event.type === 'notice') appendActivity('Note', event.message);
  drawStage();
}
async function startRecording() {
  const e = state.current; const canvas = $('#stage'); canvas.width = e.settings.width; canvas.height = e.settings.height;
  state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  state.audioDestination = state.audioContext.createMediaStreamDestination();
  state.analyser = state.audioContext.createAnalyser(); state.analyser.fftSize = 256;
  state.audioElement = new Audio(); state.audioElement.preload = 'auto';
  const source = state.audioContext.createMediaElementSource(state.audioElement);
  source.connect(state.analyser); state.analyser.connect(state.audioDestination); state.analyser.connect(state.audioContext.destination);
  state.sandboxAudioElement = new Audio(); state.sandboxAudioElement.preload = 'auto';
  state.sandboxAudioElement.onended = () => { state.sandboxPlaying = false; maybeFinish(); };
  const sandboxSource = state.audioContext.createMediaElementSource(state.sandboxAudioElement);
  sandboxSource.connect(state.audioDestination); sandboxSource.connect(state.audioContext.destination);
  const stream = new MediaStream([...canvas.captureStream(30).getTracks(), ...state.audioDestination.stream.getTracks()]);
  const mime = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(x => MediaRecorder.isTypeSupported(x));
  state.recorderChunks = []; state.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
  state.recorder.ondataavailable = e => { if (e.data.size) state.recorderChunks.push(e.data); };
  state.recorder.start(1000); state.startTime = Date.now(); state.ended = false;
  requestAnimationFrame(tick);
}
async function finishRecording() {
  const recorder = state.recorder; if (!recorder || recorder.state === 'inactive') return;
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
    state.current.video = data.video; if (data.mp4) state.current.mp4 = data.mp4; renderDownloads(); notice('The continuous take is ready to download.', true);
  } catch (error) { notice(`Cloud copy failed, but the Download finished video button still works: ${error.message}`); }
}
function maybeFinish() { if (state.ended && !state.playing && !state.sandboxPlaying && !state.queue.length) finishRecording(); }
async function playQueue() {
  if (state.playing) return; state.playing = true;
  while (state.queue.length) {
    const event = state.queue.shift(); state.speaker = event.role; state.caption = event.text;
    try {
      state.audioElement.src = event.audio;
      await state.audioElement.play();
      await new Promise((resolve, reject) => { state.audioElement.onended = resolve; state.audioElement.onerror = reject; });
    } catch (error) { notice(`Audio playback failed: ${error.message || error}`); }
    state.speaker = null; state.caption = ''; state.amplitude = 0;
    try { await api(`/api/episodes/${state.current.id}/ack`, { method: 'POST', body: JSON.stringify({ eventId: event.id }) }); } catch (error) { notice(error.message); }
  }
  state.playing = false; maybeFinish();
}
function loadImage(url) { return new Promise(resolve => { if (!url) return resolve(null); const img = new Image(); img.onload = () => resolve(img); img.onerror = () => resolve(null); img.src = url; }); }
function rounded(ctx,x,y,w,h,r){ctx.beginPath();ctx.roundRect(x,y,w,h,r)}
function wrap(ctx,text,x,y,maxWidth,lineHeight,maxLines=12){const words=String(text||'').split(/\s+/);let line='',count=0;for(const word of words){const test=line ? `${line} ${word}` : word;if(ctx.measureText(test).width>maxWidth && line){ctx.fillText(line,x,y+count*lineHeight);count++;line=word;if(count>=maxLines)break}else line=test}if(count<maxLines)ctx.fillText(line,x,y+count*lineHeight);return count+1}
function captionLines(ctx,text,maxWidth,maxLines=3){const words=String(text||'').split(/\s+/),lines=[];let line='';for(const word of words){const next=line?`${line} ${word}`:word;if(ctx.measureText(next).width>maxWidth&&line){lines.push(line);line=word;if(lines.length===maxLines-1)break}else line=next}if(line&&lines.length<maxLines)lines.push(line);return lines}
function drawCaption(ctx){if(!state.caption)return;ctx.save();ctx.font='600 25px Arial';ctx.textAlign='center';const lines=captionLines(ctx,state.caption,1000,3);const lineHeight=33,boxHeight=lines.length*lineHeight+30,y=650-boxHeight;ctx.fillStyle='#061013dc';rounded(ctx,110,y,1060,boxHeight,12);ctx.fill();ctx.fillStyle='#f4faf7';lines.forEach((line,index)=>ctx.fillText(line,640,y+31+index*lineHeight));ctx.restore()}
function drawStage() {
  const canvas=$('#stage'),ctx=canvas.getContext('2d');if(!ctx)return;const W=canvas.width,H=canvas.height,s=W/1280;ctx.save();ctx.scale(s,s);const bg=state.current?.settings.background||'#101c24',accent=state.current?.settings.accent||'#80ded1';ctx.fillStyle=bg;ctx.fillRect(0,0,1280,720);
  const gradient=ctx.createRadialGradient(640,350,10,640,350,800);gradient.addColorStop(0,'#26545044');gradient.addColorStop(1,'#00000000');ctx.fillStyle=gradient;ctx.fillRect(0,0,1280,720);
  ctx.fillStyle=accent;ctx.font='bold 13px Arial';ctx.letterSpacing='3px';ctx.fillText('THE SALES FORGE',51,48);ctx.letterSpacing='0px';ctx.fillStyle='#bbd2cc';ctx.font='14px Arial';ctx.fillText((state.current?.outline.subject||'LIVE PODCAST').slice(0,105),51,81);
  const active=state.screen.type!=='idle';const stage=state.current?.settings.layout==='stage';const cx1=active?(stage?180:320):390,cx2=active?(stage?180:960):890,y1=active?(stage?252:225):310,y2=active?(stage?485:225):310,r=active?(stage?93:100):150;
  const glow=state.current?.settings.glowStrength||1;
  drawPersona(ctx,episodePerson(state.current,'host'),'HOST',state.hostImage,cx1,y1,r,state.speaker==='host',accent,glow);
  drawPersona(ctx,episodePerson(state.current,'guest'),'GUEST',state.guestImage,cx2,y2,r,state.speaker==='guest',state.current?.settings.guestAccent||'#efbe9e',glow);
  if(active){const w=Math.round(1280*(state.current?.settings.paneWidth||66)/100),x=stage?1280-w-55:(1280-w)/2,y=stage?116:405,h=stage?500:235;ctx.fillStyle='#10242b';rounded(ctx,x,y,w,h,16);ctx.fill();ctx.strokeStyle='#487068';ctx.lineWidth=2;ctx.stroke();ctx.fillStyle=accent;ctx.font='bold 13px Arial';ctx.fillText((state.screen.title||'SANDBOX').slice(0,70),x+22,y+31);ctx.fillStyle='#a9c8c2';ctx.font='13px Arial';if(state.screenImage&&state.screen.image){try{const maxW=w-40,maxH=h-67,scale=Math.min(maxW/state.screenImage.width,maxH/state.screenImage.height),iw=state.screenImage.width*scale,ih=state.screenImage.height*scale;ctx.drawImage(state.screenImage,x+20+(maxW-iw)/2,y+49+(maxH-ih)/2,iw,ih)}catch{}}else wrap(ctx,state.screen.content||'Working…',x+22,y+67,w-44,21,Math.floor((h-65)/21));}
  drawCaption(ctx);ctx.fillStyle='#789b97';ctx.font='11px Arial';ctx.fillText('UNSCRIPTED · ONE CONTINUOUS TAKE',52,678);ctx.fillStyle='#ef8074';ctx.beginPath();ctx.arc(1179,44,5,0,Math.PI*2);ctx.fill();ctx.fillStyle='#b8d7cf';ctx.fillText('REC',1193,48);ctx.restore();
}
function drawPersona(ctx,p,role,img,x,y,r,speaking,color,glow=1){const power=speaking?Math.min(1,state.amplitude*4+.12):0;ctx.save();ctx.shadowColor=color;ctx.shadowBlur=speaking?(26+power*90)*glow:0;ctx.beginPath();ctx.arc(x,y,r+5+power*7,0,Math.PI*2);ctx.strokeStyle=color;ctx.globalAlpha=speaking?.5+power*.5:.25;ctx.lineWidth=(speaking?5+power*7:3)*glow;ctx.stroke();ctx.restore();ctx.save();ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.clip();if(img)ctx.drawImage(img,x-r,y-r,r*2,r*2);else{ctx.fillStyle=color;ctx.fillRect(x-r,y-r,r*2,r*2);ctx.fillStyle='#173038';ctx.font=`bold ${r}px Arial`;ctx.textAlign='center';ctx.fillText((p?.name||'?')[0].toUpperCase(),x,y+r*.35)}ctx.restore();ctx.fillStyle='#f1f5f1';ctx.font='bold 19px Arial';ctx.textAlign='center';ctx.fillText((p?.name||role).slice(0,24),x,y+r+35);ctx.fillStyle=color;ctx.font='bold 10px Arial';ctx.letterSpacing='2px';ctx.fillText(role,x,y+r+54);ctx.letterSpacing='0px';ctx.textAlign='left'}
function tick(){if(state.recorder?.state!=='recording')return;if(state.analyser&&state.speaker){const data=new Uint8Array(state.analyser.frequencyBinCount);state.analyser.getByteFrequencyData(data);state.amplitude=data.reduce((a,b)=>a+b,0)/data.length/255}else state.amplitude*=.8;drawStage();const elapsed=Math.floor((Date.now()-state.startTime)/1000);$('#stageTimer').textContent=`${String(Math.floor(elapsed/60)).padStart(2,'0')}:${String(elapsed%60).padStart(2,'0')}`;requestAnimationFrame(tick)}

function openExplainerDialog(item = null) {
  const form = $('#explainerForm'); form.reset(); form.dataset.explainerId = item?.id || '';
  if (item) {
    for (const name of ['title','url','brief','voice','loginUrl','usernameSelector','passwordSelector','submitSelector']) {
      if (form.elements[name] && item[name] != null) form.elements[name].value = item[name];
    }
    form.elements.authRequired.checked = !!item.authRequired;
  }
  $('#explainerCredentials').classList.toggle('hidden', !form.elements.authRequired.checked);
  for (const name of ['username','password']) form.elements[name].required = form.elements.authRequired.checked;
  $('#explainerDialog').showModal();
}

async function saveExplainerForm(event) {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('[type=submit]'); button.disabled = true;
  try {
    const authRequired = form.elements.authRequired.checked;
    if (authRequired && (!form.elements.username.value || !form.elements.password.value)) throw new Error('Enter the login username and password.');
    const existing = state.explainers.find(item => item.id === form.dataset.explainerId);
    const item = existing || await api('/api/explainers', { method: 'POST', body: JSON.stringify({
      title: form.elements.title.value, url: form.elements.url.value, brief: form.elements.brief.value,
      authRequired, voice: form.elements.voice.value, loginUrl: form.elements.loginUrl.value,
      usernameSelector: form.elements.usernameSelector.value, passwordSelector: form.elements.passwordSelector.value,
      submitSelector: form.elements.submitSelector.value
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
    button.textContent = 'Starting workflow…';
    await api(`/api/explainers/${item.id}/start`, { method: 'POST' });
    $('#explainerDialog').close();
    await refreshMe(); await refresh(); navigate('explainers'); scheduleExplainerPoll();
    notice('The explainer is in production.', true);
  } catch (error) { notice(error.message); }
  finally { button.disabled = false; button.textContent = 'Create and generate'; }
}

function scheduleExplainerPoll() {
  clearTimeout(state.explainerPoll);
  if (!state.explainers.some(item => ['queued','running'].includes(item.status))) return;
  state.explainerPoll = setTimeout(async () => { try { await refresh(); scheduleExplainerPoll(); } catch (error) { notice(error.message); } }, 4000);
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
}

$$('[data-view]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.view)));
['#newEpisodeTop','#newEpisodeHero','#newEpisodeButton'].forEach(s=>$(s).addEventListener('click',openEpisodeDialog));
['#newPersonaHero','#newPersonaButton'].filter(s=>$(s)).forEach(s=>$(s).addEventListener('click',()=>openPersona()));
['#newExplainerHero','#newExplainerButton'].forEach(s=>$(s).addEventListener('click',openExplainerDialog));
$$('.close-dialog').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
$('#personaForm').addEventListener('submit',savePersona);$('#episodeForm').addEventListener('submit',saveEpisode);
$('#explainerForm').addEventListener('submit',saveExplainerForm);
$('#explainerForm').elements.authRequired.addEventListener('change',event=>{$('#explainerCredentials').classList.toggle('hidden',!event.target.checked);for(const name of ['username','password'])$('#explainerForm').elements[name].required=event.target.checked});
$('#personaForm').elements.imageFile.addEventListener('change',event=>{const file=event.target.files[0];if(file)$('#imagePreview').innerHTML=`<img src="${URL.createObjectURL(file)}" alt="Image preview">`});
$('#personaForm').elements.knowledgeFiles.addEventListener('change',event=>{$('#knowledgeList').textContent=[...$('#personaForm')._knowledge.map(k=>k.name),...[...event.target.files].map(f=>f.name)].join(' · ')});
$('#speechProvider').addEventListener('change',()=>{updateVoiceSuggestions();$('#voiceSelect').value=state.config?.providers.voices?.[$('#speechProvider').value]?.[0]||''});
$('#episodeForm').elements.interjectProbability.addEventListener('input',event=>{$('#interjectValue').textContent=`${event.target.value}%`});
$('#episodeForm').elements.paneWidth.addEventListener('input',event=>{$('#paneValue').textContent=`${event.target.value}%`});
$('#episodeForm').elements.authRequired.addEventListener('change',event=>{$('#episodeCredentials').classList.toggle('hidden',!event.target.checked);for(const name of ['demoUsername','demoPassword'])$('#episodeForm').elements[name].required=event.target.checked});
document.addEventListener('click',event=>{const ep=event.target.closest('[data-episode]');if(ep)openStudio(ep.dataset.episode).catch(e=>notice(e.message));const edit=event.target.closest('button[data-edit]');if(edit)openPersona(person(edit.dataset.edit))});
document.addEventListener('click', event => { const retry = event.target.closest('[data-retry-explainer]'); if (retry) openExplainerDialog(state.explainers.find(item => item.id === retry.dataset.retryExplainer)); });
$('#backToEpisodes').addEventListener('click',()=>navigate('episodes'));
$('#fullscreenStage').addEventListener('click',()=>$('#stage').requestFullscreen());
$$('.side-tab').forEach(b=>b.addEventListener('click',()=>{$$('.side-tab').forEach(x=>x.classList.toggle('active',x===b));$('#transcriptPane').classList.toggle('hidden',b.dataset.side!=='transcript');$('#activityPane').classList.toggle('hidden',b.dataset.side!=='activity')}));
$('#startEpisode').addEventListener('click',async()=>{const button=$('#startEpisode');try{for(const p of [episodePerson(state.current,'host'),episodePerson(state.current,'guest')]){if(!state.config.providers.ready.models[p.modelProvider||'gateway']||!state.config.providers.ready.speech[p.speechProvider||'gateway'])throw new Error(`Configure ${p.name}'s model and speech providers before starting.`)}const credentials=await credentialsForCurrentEpisode();if(state.current.settings.demo?.authRequired&&!credentials)return;button.disabled=true;button.textContent=credentials?'Signing in securely…':'Preparing…';if(credentials){await api(`/api/episodes/${state.current.id}/prepare`,{method:'POST',body:JSON.stringify({credentials})});state.credentials.delete(state.current.id)}await startRecording();button.classList.add('hidden');await api(`/api/episodes/${state.current.id}/start`,{method:'POST'});setStatus('preparing')}catch(error){notice(error.message);if(state.recorder?.state==='recording')state.recorder.stop()}finally{button.disabled=false;button.textContent='Start recording'}});
$('#stopEpisode').addEventListener('click',async()=>{try{await api(`/api/episodes/${state.current.id}/stop`,{method:'POST'});notice('Stopping after the current segment.',true)}catch(error){notice(error.message)}});
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
