import { $, $$, esc, state, api, notice, busy, shortDate, clock, money, itemTitle, episodePerson, refreshMe, refreshData, confirmDialog } from './core.js';
import { timedSubtitleCues, cueAt } from './captions.js';
import { friendlyError } from './errors.js';
import { CAST_ROLES, castRoles, roleAccent, roleLabel } from './cast.js';
import { drawStageScene, loadImage } from './stage.js';
import { openPublishDialog } from './publish.js';

// The podcast studio: live stage and playback while recording, then a player with chapters and a
// clickable transcript once the episode is finished.
const s = {
  eventSource: null, pollTimer: null, recorder: null, recorderChunks: [], audioContext: null, audioElement: null, speechElements: {}, sandboxAudioElement: null,
  sandboxPlaying: false, screenVideoElement: null, screenVideoPlaying: false, pendingSandboxAudio: null, audioUnlock: null, analyser: null, audioDestination: null,
  queue: [], playing: false, screen: { type: 'idle', title: 'The stage is ready', content: '' }, speaker: null, caption: '', captionCues: null, captionElement: null, captionStarted: 0,
  amplitude: 0, startTime: 0, roleImages: {}, screenImage: null, ended: false, seen: new Set(), localVideoUrl: null, mediaCancels: new Map(), cursor: 0, activeEventId: '', lastCue: ''
};
const FINISHED = ['complete', 'stopped', 'failed', 'interrupted'];
const SILENT_AUDIO = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

export function studioEpisode() { return state.current; }

export async function openStudio(id) {
  s.eventSource?.close();
  clearTimeout(s.pollTimer);
  if (state.current?.id !== id && s.recorder?.state === 'recording') await finishRecording();
  if (s.localVideoUrl) { URL.revokeObjectURL(s.localVideoUrl); s.localVideoUrl = null; }
  state.current = await api(`/api/episodes/${id}`);
  const e = state.current;
  e.turns = [];
  Object.assign(s, { screen: { type: 'idle', title: 'The stage is ready', content: '' }, screenImage: null, screenVideoElement: null, screenVideoPlaying: false, speaker: null, caption: '', captionCues: null, amplitude: 0, queue: [], playing: false, sandboxPlaying: false, pendingSandboxAudio: null, seen: new Set(), ended: FINISHED.includes(e.status), activeEventId: '' });
  s.roleImages = Object.fromEntries(await Promise.all(castRoles(e).map(async role => [role, await loadImage(episodePerson(e, role)?.image)])));
  $('#studioTitle').textContent = itemTitle('podcast', e);
  $('#studioMeta').textContent = `${castRoles(e).map(role => episodePerson(e, role)?.name || roleLabel(role)).join(' × ')} · ${shortDate(e.createdAt)}${e.settings?.playbackMode === 'background' ? ' · background generation' : ''}`;
  $('#transcriptPane').innerHTML = ''; $('#activityPane').innerHTML = '';
  $('#enableAudio').classList.add('hidden');
  for (const event of e.events) processEvent(event, true);
  s.cursor = e.events.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0);
  refreshStudio();
  draw();
  if (['running', 'preparing', 'draft'].includes(e.status) && state.config?.realtime === 'poll') pollEpisode(id);
  else if (['running', 'preparing', 'draft'].includes(e.status)) {
    s.eventSource = new EventSource(`/api/episodes/${id}/events`);
    s.eventSource.onmessage = message => processEvent(JSON.parse(message.data));
    s.eventSource.onerror = () => { if (!s.ended) notice('Live connection interrupted. Reconnecting…'); };
  }
  if (e.videoStatus === 'processing') pollPodcastVideo(id);
}

export function leaveStudio() {
  s.eventSource?.close();
  clearTimeout(s.pollTimer);
}

// Everything that depends on the episode's status: buttons, tracker, error panel, player, files.
function refreshStudio() {
  const e = state.current;
  if (!e) return;
  const status = e.status;
  $('#liveStatus').textContent = status.toUpperCase(); $('#liveStatus').className = `pill ${status}`;
  $('#startEpisode').classList.toggle('hidden', status !== 'draft');
  $('#stopEpisode').classList.toggle('hidden', !['running', 'preparing'].includes(status));
  $('#restartEpisode').classList.toggle('hidden', !FINISHED.includes(status));
  $('#resumeEpisode').classList.toggle('hidden', !(['failed', 'interrupted'].includes(status) && e.turns?.length));
  $('#renderEpisode').classList.toggle('hidden', !(['complete', 'stopped'].includes(status) && e.videoStatus === 'failed' && state.config?.storage?.remoteAssets));
  renderProgress(); renderError(); renderPlayer(); renderDownloads();
}

function renderProgress() {
  const e = state.current;
  const minutes = e.turns.reduce((sum, turn) => sum + String(turn.text).split(/\s+/).length, 0) / 150;
  const target = Number(e.settings?.targetMinutes) || 0;
  const lines = e.turns.length;
  const rendering = e.videoStatus === 'processing';
  const ready = e.videoStatus === 'complete' || (e.mp4 && !rendering);
  const failed = e.status === 'failed' || e.videoStatus === 'failed';
  const current = e.status === 'draft' ? 0 : ['preparing', 'running'].includes(e.status) ? 1 : rendering || (FINISHED.includes(e.status) && !ready && !failed && state.config?.storage?.remoteAssets) ? 2 : ready ? 3 : e.status === 'failed' ? 1 : 2;
  const steps = [
    ['Set up', e.status === 'draft' ? 'Ready to record' : 'Done'],
    ['Conversation', ['preparing', 'running'].includes(e.status) ? `${lines} line${lines === 1 ? '' : 's'} · ${minutes.toFixed(1)}${target ? ` of ~${target}` : ''} min spoken` : lines ? `${lines} lines · ${minutes.toFixed(1)} min` : 'Not started'],
    ['Video', rendering ? 'Assembling MP4, captions, audio · usually 2–6 min' : e.videoStatus === 'failed' ? 'Failed' : ready ? 'Done' : 'After the conversation'],
    ['Ready', ready ? 'Download or publish' : '—']
  ];
  $('#progressTracker').innerHTML = steps.map(([title, detail], index) => {
    const stateName = failed && index === current ? 'failed' : index < current || (index === 3 && ready) ? 'done' : index === current ? 'current' : 'todo';
    return `<li class="${stateName}" ${index === current ? 'aria-current="step"' : ''}><span class="step-dot" aria-hidden="true">${stateName === 'done' ? '✓' : stateName === 'failed' ? '!' : index + 1}</span><strong>${title}</strong><small>${esc(detail)}</small></li>`;
  }).join('');
}

function renderError() {
  const e = state.current, panel = $('#studioError');
  const info = friendlyError(e.status === 'failed' ? e.error : e.videoStatus === 'failed' ? e.videoError : '');
  panel.classList.toggle('hidden', !info);
  panel.innerHTML = info ? `<strong>${esc(info.title)}</strong><p>${esc(info.hint)}</p><details><summary>Technical details</summary><code>${esc(info.detail)}</code></details>` : '';
}

// Finished episodes get a player with chapter jumps and a transcript that follows playback.
function renderPlayer() {
  const e = state.current;
  const video = e.mp4 || e.video || (state.config?.storage?.remoteAssets ? null : s.localVideoUrl);
  const finished = FINISHED.includes(e.status) && video;
  $('#playerSection').classList.toggle('hidden', !finished);
  $('#liveLayout').classList.toggle('hidden', Boolean(finished && e.timeline?.length));
  if (!finished) return;
  const player = $('#reviewPlayer');
  if (player.dataset.source !== video) {
    player.dataset.source = video;
    player.innerHTML = '';
    player.src = video;
    const burned = e.settings?.captionOptions?.enabled !== false && e.settings?.captionsEnabled !== false;
    if (!burned && e.timeline?.length) player.insertAdjacentHTML('beforeend', `<track kind="captions" srclang="en" label="Captions" src="/api/episodes/${e.id}/export?format=vtt" default>`);
    $('#captionsToggle').closest('label').classList.toggle('hidden', burned);
    $('#chapterList').innerHTML = (e.chapters || []).map(chapter => `<button type="button" class="chip" data-seek="${chapter.start}"><span>${clock(chapter.start)}</span> ${esc(chapter.title)}</button>`).join('') || (burned ? '<span class="hint">Captions are burned into this video.</span>' : '');
    $('#playerTranscript').innerHTML = (e.timeline || []).map((line, index) => `<li><button type="button" data-seek="${line.start}" data-line="${index}" style="--role:${roleAccent(e.settings, line.role)}"><span class="line-time">${clock(line.start)}</span><strong>${esc(line.speaker)}</strong><span class="line-text">${esc(line.text)}</span></button></li>`).join('');
  }
}

function followTranscript() {
  const e = state.current, player = $('#reviewPlayer');
  if (!e?.timeline?.length) return;
  const time = player.currentTime;
  let active = -1;
  e.timeline.forEach((line, index) => { if (time >= line.start - 0.05) active = index; });
  $$('#playerTranscript [data-line]').forEach(button => {
    const on = Number(button.dataset.line) === active;
    if (on && button.getAttribute('aria-current') !== 'true') { button.setAttribute('aria-current', 'true'); button.scrollIntoView({ block: 'nearest' }); }
    else if (!on) button.removeAttribute('aria-current');
  });
}

function renderDownloads() {
  const e = state.current;
  const stem = itemTitle('podcast', e).replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'podcast';
  const video = e.mp4 || e.video || (state.config?.storage?.remoteAssets ? null : s.localVideoUrl);
  const transcriptUrl = URL.createObjectURL(new Blob([e.turns.map(turn => `${roleLabel(turn.role)}: ${turn.text}`).join('\n\n')], { type: 'text/plain' }));
  const publish = e.mp4 && ['complete', 'stopped'].includes(e.status) ? '<button type="button" class="video-download" data-publish-episode>Publish · YouTube, shorts, languages, feed</button>' : '';
  $('#downloads').innerHTML = `${publish}${video ? `<a class="${publish ? '' : 'video-download'}" href="${esc(video)}" download="${esc(stem)}.${e.mp4 ? 'mp4' : 'webm'}">↓ Video</a>` : ''}${e.mp3?.url ? `<a href="${esc(e.mp3.url)}" download>↓ Audio (MP3)</a>` : ''}${e.captions ? `<a href="${esc(e.captions)}" download="${esc(stem)}.srt">↓ Captions</a>` : ''}${e.videoStatus === 'processing' ? '<span class="hint">The edited MP4 and captions are being prepared…</span>' : ''}${e.timeline?.length ? `<a href="/api/episodes/${e.id}/export?format=txt" download>↓ Transcript</a>` : `<a href="${transcriptUrl}" download="${esc(stem)}-transcript.txt">↓ Transcript</a>`}`;
  if (FINISHED.includes(e.status)) loadRunCost(e.id);
}

async function loadRunCost(id) {
  const box = $('#runCost');
  try {
    const usage = await api(`/api/episodes/${id}/usage`);
    if (state.current?.id !== id || !usage.calls) { box.classList.add('hidden'); return; }
    const models = Object.entries(usage.models).map(([model, entry]) => `${esc(model || 'unknown')} (${entry.calls})`).join(', ');
    box.innerHTML = `<strong>Run cost ≈ ${money(usage.costUsd)}</strong><span>${usage.calls} model and voice calls · ${usage.characters.toLocaleString()} characters voiced</span><small>Models: ${models}</small>`;
    box.classList.remove('hidden');
  } catch { box.classList.add('hidden'); }
}

async function pollEpisode(id) {
  if (state.current?.id !== id || s.ended) return;
  let delay = 450;
  try {
    const data = await api(`/api/episodes/${id}/events?format=json&after=${s.cursor || 0}`);
    for (const event of data.events || []) processEvent(event);
    s.cursor = data.cursor || s.cursor;
    Object.assign(state.current, data.episode || {});
    if (!data.events?.length) delay = 900;
    refreshStudio();
  } catch (cause) {
    delay = 2500;
    if (!s.ended) notice(`Live update failed: ${cause.message}`);
  }
  if (state.current?.id === id && !s.ended) s.pollTimer = setTimeout(() => pollEpisode(id), delay);
}

async function pollPodcastVideo(id) {
  if (state.current?.id !== id) return;
  try {
    const fresh = await api(`/api/episodes/${id}`);
    const wasProcessing = state.current.videoStatus === 'processing';
    Object.assign(state.current, { video: fresh.video, mp4: fresh.mp4, captions: fresh.captions, videoStatus: fresh.videoStatus, videoError: fresh.videoError, quality: fresh.quality, timeline: fresh.timeline, chapters: fresh.chapters, mp3: fresh.mp3, thumbnail: fresh.thumbnail, youtube: fresh.youtube, status: fresh.status });
    refreshStudio();
    if (!fresh.videoStatus || fresh.videoStatus === 'processing') setTimeout(() => pollPodcastVideo(id), 3000);
    else if (fresh.mp4 && wasProcessing) {
      notice('The finished video is ready.', true, { action: { label: 'Publish', run: () => openPublishDialog('podcast', state.current, { api, notice, refreshMe, costs: state.config?.costs }) } });
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('Your podcast is ready', { body: itemTitle('podcast', state.current) });
    }
  } catch (error) { notice(`Could not check video progress: ${error.message}`); }
}

function credentialsForCurrentEpisode() {
  if (!state.current?.settings?.demo?.authRequired) return Promise.resolve(null);
  if (state.current.demoPrepared) return Promise.resolve(null);
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
    const desktopReady = async () => busy($('#episodeDesktopReady'), async () => {
      try {
        await api(`/api/episodes/${state.current.id}/desktop-ready`, { method: 'POST' });
        state.current.demoPrepared = true;
        value = { manualPrepared: true };
        dialog.close();
      }
      catch (error) { notice(error.message); }
    });
    const close = () => { form.removeEventListener('submit', submit); $('#openEpisodeDesktop').removeEventListener('click', openDesktop); $('#episodeDesktopReady').removeEventListener('click', desktopReady); dialog.removeEventListener('close', close); resolve(value); };
    form.addEventListener('submit', submit); $('#openEpisodeDesktop').addEventListener('click', openDesktop); $('#episodeDesktopReady').addEventListener('click', desktopReady); dialog.addEventListener('close', close); dialog.showModal();
  });
}

function appendTranscript(role, text, sources = [], eventId = '') {
  const pane = $('#transcriptPane');
  const name = episodePerson(state.current, role)?.name || roleLabel(role);
  pane.insertAdjacentHTML('beforeend', `<div class="transcript-item ${esc(role)}" data-event="${esc(eventId)}" style="--role:${roleAccent(state.current?.settings, role)}"><strong>${esc(name)} · ${esc(roleLabel(role))}</strong><p>${esc(text)}</p>${sources?.length ? `<small class="sources">Sources: ${sources.map(esc).join(', ')}</small>` : ''}</div>`);
  pane.scrollTop = pane.scrollHeight;
}
function appendActivity(title, content, assetUrl) {
  const pane = $('#activityPane');
  const link = assetUrl?.startsWith('/assets/') ? `<br><a href="${esc(assetUrl)}" target="_blank" rel="noopener">Open artifact ↗</a>` : '';
  pane.insertAdjacentHTML('beforeend', `<div class="activity-item"><strong>${esc(title)}</strong>${esc(content || '')}${link}</div>`);
  pane.scrollTop = pane.scrollHeight;
}

function processEvent(event, history = false) {
  if (s.seen.has(event.id)) return;
  s.seen.add(event.id);
  if (event.type === 'status') {
    state.current.status = event.status;
    if (event.error) state.current.error = event.error;
    if (['complete', 'stopped', 'failed'].includes(event.status)) {
      s.ended = true; s.eventSource?.close(); maybeFinish();
      if (!history && event.status !== 'failed') { state.current.videoStatus = state.config?.storage?.remoteAssets ? 'processing' : state.current.videoStatus; pollPodcastVideo(state.current.id); }
    }
    if (!history) refreshStudio();
  }
  if (event.type === 'speech') {
    state.current.turns.push({ role: event.role, text: event.text });
    appendTranscript(event.role, event.text, event.sources, event.id);
    if (!history && !event.acknowledged) { s.queue.push(event); playQueue(); }
  }
  if (event.type === 'tool_start') { appendActivity(`Started ${event.tool}`, JSON.stringify(event.input).slice(0, 350)); s.screen = { type: 'working', title: `${event.tool} in progress`, content: 'Live sandbox activity…' }; }
  if (event.type === 'tool_output') s.screen = event.screen || { type: 'terminal', title: event.tool, content: event.chunk };
  if (event.type === 'tool_end') {
    s.screen = event.screen;
    appendActivity(`${event.tool} finished`, event.screen?.content?.slice(0, 500), event.screen?.asset || event.screen?.video || event.screen?.image);
    if (event.screen?.image) loadImage(event.screen.image).then(img => { s.screenImage = img; draw(); });
    if (!history && event.screen?.video) playScreenVideo(event.screen.video);
    if (!history && event.screen?.audio) playSandboxAudio(event.screen.audio);
  }
  if (event.type === 'interrupt') appendActivity(`${roleLabel(event.by)} interjected`, event.reason);
  if (event.type === 'notice') appendActivity('Note', event.message);
  if (!history) renderProgress();
  draw();
}

// --- Audio playback and local recording -------------------------------------------------------
function initializeAudioGraph() {
  if (s.audioContext && CAST_ROLES.every(role => s.speechElements[role]) && s.sandboxAudioElement) return;
  s.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  s.audioDestination = s.audioContext.createMediaStreamDestination();
  s.analyser = s.audioContext.createAnalyser(); s.analyser.fftSize = 256;
  for (const role of CAST_ROLES) {
    const element = new Audio(); element.preload = 'auto'; s.speechElements[role] = element;
    s.audioContext.createMediaElementSource(element).connect(s.analyser);
  }
  s.audioElement = s.speechElements.host;
  s.analyser.connect(s.audioDestination); s.analyser.connect(s.audioContext.destination);
  s.sandboxAudioElement = new Audio(); s.sandboxAudioElement.preload = 'auto';
  s.sandboxAudioElement.onended = () => { s.sandboxPlaying = false; maybeFinish(); };
  const sandboxSource = s.audioContext.createMediaElementSource(s.sandboxAudioElement);
  sandboxSource.connect(s.audioDestination); sandboxSource.connect(s.audioContext.destination);
}
function unlockAudio() {
  initializeAudioGraph();
  const attempts = [];
  if (s.audioContext.state === 'suspended') attempts.push(s.audioContext.resume());
  for (const element of [...Object.values(s.speechElements), s.sandboxAudioElement]) {
    element.src = SILENT_AUDIO;
    attempts.push(Promise.resolve(element.play()).then(() => { element.pause(); element.removeAttribute('src'); element.load(); }));
  }
  s.audioUnlock = Promise.allSettled(attempts);
  return s.audioUnlock;
}
const playbackBlocked = error => error?.name === 'NotAllowedError' || /not allowed|user agent|permission|autoplay/i.test(error?.message || String(error));
function showAudioGate() { $('#enableAudio').classList.remove('hidden'); notice('The browser paused audio. Click Enable audio to continue the recording.'); }
function playToEnd(element, url) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { element.removeEventListener('ended', ended); element.removeEventListener('error', failed); s.mediaCancels.delete(element); };
    const ended = () => { cleanup(); resolve(); };
    const failed = () => { const error = element.error || new Error('The audio file could not be played.'); cleanup(); reject(error); };
    s.mediaCancels.set(element, () => { cleanup(); reject(new DOMException('Playback stopped.', 'AbortError')); });
    element.addEventListener('ended', ended, { once: true });
    element.addEventListener('error', failed, { once: true });
    element.src = url;
    Promise.resolve(element.play()).catch(error => { cleanup(); reject(error); });
  });
}
async function playSandboxAudio(url) {
  initializeAudioGraph();
  s.sandboxPlaying = true;
  try { await playToEnd(s.sandboxAudioElement, url); s.pendingSandboxAudio = null; }
  catch (error) {
    s.sandboxPlaying = false;
    if (s.ended && error?.name === 'AbortError') return;
    if (playbackBlocked(error)) { s.pendingSandboxAudio = url; showAudioGate(); return; }
    notice(`Sandbox sound failed: ${error.message || error}`);
  }
  s.sandboxPlaying = false; maybeFinish();
}
async function startRecording() {
  const e = state.current, canvas = $('#stage');
  canvas.width = e.settings.width; canvas.height = e.settings.height;
  initializeAudioGraph();
  if (s.audioUnlock) await s.audioUnlock;
  if (s.audioContext.state === 'suspended') await s.audioContext.resume();
  if (state.config?.storage?.remoteAssets) {
    s.recorderChunks = []; s.recorder = { state: 'recording', serverTimeline: true };
    s.startTime = Date.now(); s.ended = false; requestAnimationFrame(tick);
    return;
  }
  const stream = new MediaStream([...canvas.captureStream(30).getTracks(), ...s.audioDestination.stream.getTracks()]);
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
  s.recorderChunks = []; s.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
  s.recorder.ondataavailable = event => { if (event.data.size) s.recorderChunks.push(event.data); };
  s.recorder.start(1000); s.startTime = Date.now(); s.ended = false;
  requestAnimationFrame(tick);
}
async function finishRecording() {
  const recorder = s.recorder;
  if (!recorder || recorder.state === 'inactive') return;
  if (recorder.serverTimeline) { recorder.state = 'inactive'; return; }
  await new Promise(resolve => { recorder.addEventListener('stop', resolve, { once: true }); recorder.stop(); });
  const blob = new Blob(s.recorderChunks, { type: recorder.mimeType || 'video/webm' });
  if (!blob.size) return;
  if (s.localVideoUrl) URL.revokeObjectURL(s.localVideoUrl);
  s.localVideoUrl = URL.createObjectURL(blob);
  refreshStudio();
  notice('The video is ready to download. Saving a cloud copy…', true);
  try {
    const token = await state.clerk?.session?.getToken();
    const response = await fetch(`/api/episodes/${state.current.id}/video`, { method: 'PUT', headers: { 'Content-Type': 'video/webm', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: blob });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Upload failed');
    Object.assign(state.current, { video: data.video, mp4: data.mp4 || state.current.mp4 });
    refreshStudio();
    notice('The recording is saved.', true);
  } catch (error) { notice(`Cloud copy failed, but the download button still works: ${error.message}`); }
}
function maybeFinish() { if (s.ended && !s.playing && !s.sandboxPlaying && !s.screenVideoPlaying && !s.queue.length) finishRecording(); }
async function playScreenVideo(url) {
  const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = url;
  s.screenVideoElement = video; s.screenVideoPlaying = true;
  try { await video.play(); await new Promise(resolve => { video.addEventListener('ended', resolve, { once: true }); video.addEventListener('error', resolve, { once: true }); }); }
  catch (error) { notice(`Desktop action playback failed: ${error.message || error}`); }
  finally { s.screenVideoPlaying = false; if (s.screenVideoElement === video) s.screenVideoElement = null; maybeFinish(); }
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
  const element = s.speechElements[event.role] || s.speechElements.host;
  Object.assign(s, { audioElement: element, speaker: event.role, caption: event.text, captionCues: timedSubtitleCues(event.text, 1), captionElement: element, captionStarted: performance.now(), activeEventId: event.id, lastCue: '' });
  markActiveLine(event.id);
  const playback = playToEnd(element, event.audio);
  try { await api(`/api/episodes/${state.current.id}/ack`, { method: 'POST', body: JSON.stringify({ eventId: event.id }) }); } catch (error) { notice(error.message); }
  await waitForTail(element);
  let overlap = null;
  const next = s.queue[0];
  if (next && next.role !== event.role && !s.ended) { s.queue.shift(); overlap = playSpeechEvent(next); }
  await playback;
  if (overlap) await overlap;
  if (s.speaker === event.role) { s.speaker = null; s.caption = ''; s.amplitude = 0; markActiveLine(''); }
}
async function playQueue() {
  if (s.playing) return;
  s.playing = true;
  while (s.queue.length) {
    const event = s.queue.shift();
    try { await playSpeechEvent(event); }
    catch (error) {
      if (s.ended && error?.name === 'AbortError') break;
      if (playbackBlocked(error)) { s.queue.unshift(event); showAudioGate(); break; }
      notice(`Audio playback failed: ${error.message || error}`);
    }
  }
  s.playing = false; s.speaker = null; s.caption = ''; s.amplitude = 0; markActiveLine(''); draw(); maybeFinish();
}
function stopLocalPlayback() {
  Object.assign(s, { ended: true, queue: [], pendingSandboxAudio: null, playing: false, sandboxPlaying: false, screenVideoPlaying: false });
  if (s.screenVideoElement) { s.screenVideoElement.pause(); s.screenVideoElement = null; }
  for (const [element, cancel] of s.mediaCancels) { cancel(); element.pause(); element.removeAttribute('src'); element.load(); }
  s.mediaCancels.clear(); s.speaker = null; s.caption = ''; s.amplitude = 0; $('#enableAudio').classList.add('hidden'); draw();
}

// --- Live transcript highlighting -------------------------------------------------------------
function markActiveLine(eventId) {
  $$('#transcriptPane .transcript-item').forEach(item => {
    const on = item.dataset.event === eventId && eventId;
    item.classList.toggle('speaking', Boolean(on));
    if (!on) { const p = item.querySelector('p'); if (p?.querySelector('mark')) p.textContent = p.textContent; }
    else item.scrollIntoView({ block: 'nearest' });
  });
}
function liveCaptionText() {
  if (!s.captionCues?.length) return s.caption;
  const element = s.captionElement, duration = element?.duration;
  const progress = Number.isFinite(duration) && duration > 0 ? element.currentTime / duration : Math.min(.999, (performance.now() - s.captionStarted) / 1000 / Math.max(1.5, s.caption.split(/\s+/).length / 2.6));
  return cueAt(s.captionCues, progress)?.text || '';
}
function highlightCue(text) {
  if (!s.activeEventId || text === s.lastCue) return;
  s.lastCue = text;
  const p = document.querySelector(`#transcriptPane [data-event="${CSS.escape(s.activeEventId)}"] p`);
  if (!p) return;
  const full = p.textContent, at = text ? full.indexOf(text) : -1;
  p.innerHTML = at < 0 ? esc(full) : `${esc(full.slice(0, at))}<mark>${esc(text)}</mark>${esc(full.slice(at + text.length))}`;
}

function draw() {
  const canvas = $('#stage');
  if (!canvas || !state.current) return;
  const caption = s.caption ? liveCaptionText() : '';
  highlightCue(caption);
  const screenVisual = s.screenVideoElement && s.screenVideoElement.readyState >= 2 ? s.screenVideoElement : s.screenImage && s.screen.image ? s.screenImage : null;
  drawStageScene(canvas, { episode: state.current, screen: s.screen, speaker: s.speaker, amplitude: s.amplitude, roleImages: s.roleImages, captionText: caption, screenVisual, brandName: state.current.brand?.name });
}
function tick() {
  if (s.recorder?.state !== 'recording') return;
  if (s.analyser && s.speaker) { const data = new Uint8Array(s.analyser.frequencyBinCount); s.analyser.getByteFrequencyData(data); s.amplitude = data.reduce((a, b) => a + b, 0) / data.length / 255; }
  else s.amplitude *= .8;
  draw();
  const elapsed = Math.floor((Date.now() - s.startTime) / 1000);
  $('#stageTimer').textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  requestAnimationFrame(tick);
}

// --- Controls ---------------------------------------------------------------------------------
async function restartPodcast(id) {
  if (!await confirmDialog({ title: 'Record this episode again?', message: 'A new take with the same cast and settings is created and recorded. It uses 20 credits.', confirm: 'Record again · 20 credits' })) return;
  const audioUnlock = unlockAudio();
  const restarted = await api(`/api/episodes/${id}/restart`, { method: 'POST' });
  await refreshMe(); await refreshData();
  location.hash = `#/studio/${restarted.id}`;
  await audioUnlock;
  setTimeout(() => $('#startEpisode').click(), 400);
}

export function initStudio() {
  $('#startEpisode').addEventListener('click', async () => {
    const button = $('#startEpisode');
    try {
      const audioUnlock = unlockAudio();
      for (const p of castRoles(state.current).map(role => episodePerson(state.current, role))) {
        if (!state.config.providers.ready.models[p.modelProvider || 'gateway'] || !state.config.providers.ready.speech[p.speechProvider || 'gateway']) throw new Error(`Configure ${p.name}'s model and voice providers before starting.`);
      }
      const credentials = await credentialsForCurrentEpisode();
      if (state.current.settings.demo?.authRequired && !credentials) return;
      await busy(button, async () => {
        if (credentials && !credentials.manualPrepared) {
          await api(`/api/episodes/${state.current.id}/prepare`, { method: 'POST', body: JSON.stringify({ credentials }) });
          state.current.demoPrepared = true;
        }
        await audioUnlock; await startRecording();
        // Keep the credentials until start succeeds. The start route can use them as an atomic
        // fallback if a separate serverless invocation has not observed the preparation write yet.
        await api(`/api/episodes/${state.current.id}/start`, { method: 'POST', body: JSON.stringify(credentials && !credentials.manualPrepared ? { credentials } : {}) });
        state.credentials.delete(state.current.id);
        state.current.status = 'preparing'; refreshStudio(); await refreshMe();
        if (state.current.settings.playbackMode === 'background') notice('Recording in the background. You can close this tab; we will email you when it is ready if notifications are on.', true);
        if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
      }, credentials ? 'Signing in securely…' : 'Starting…');
    } catch (error) { notice(error.message); if (s.recorder?.state === 'recording' && !s.recorder.serverTimeline) s.recorder.stop(); }
  });
  $('#enableAudio').addEventListener('click', () => busy($('#enableAudio'), async () => {
    try { await unlockAudio(); if (s.audioContext.state === 'suspended') await s.audioContext.resume(); $('#enableAudio').classList.add('hidden'); const pending = s.pendingSandboxAudio; s.pendingSandboxAudio = null; if (pending) playSandboxAudio(pending); playQueue(); }
    catch (error) { notice(`Audio could not be enabled: ${error.message || error}`); }
  }));
  $('#restartEpisode').addEventListener('click', () => restartPodcast(state.current.id).catch(error => notice(error.message)));
  $('#resumeEpisode').addEventListener('click', () => busy($('#resumeEpisode'), async () => {
    try {
      const audioUnlock = unlockAudio();
      let credentials = null;
      if (state.current.settings.demo?.authRequired && !state.current.guestDemoDone) { credentials = await credentialsForCurrentEpisode(); if (!credentials) return; }
      await api(`/api/episodes/${state.current.id}/resume`, { method: 'POST', body: JSON.stringify({ credentials }) });
      state.credentials.delete(state.current.id);
      await audioUnlock; await openStudio(state.current.id); await startRecording(); await refreshMe();
      notice('Resuming from the last line. The conversation so far is kept.', true);
    } catch (error) { notice(error.message); }
  }));
  $('#renderEpisode').addEventListener('click', () => busy($('#renderEpisode'), async () => {
    try { await api(`/api/episodes/${state.current.id}/render`, { method: 'POST' }); Object.assign(state.current, { videoStatus: 'processing', videoError: null }); refreshStudio(); pollPodcastVideo(state.current.id); await refreshMe(); }
    catch (error) { notice(error.message); }
  }));
  $('#stopEpisode').addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Stop the episode?', message: 'The conversation ends now and the video is assembled from what was recorded.', confirm: 'Stop episode', danger: true })) return;
    busy($('#stopEpisode'), async () => {
      try { await api(`/api/episodes/${state.current.id}/stop`, { method: 'POST' }); stopLocalPlayback(); state.current.status = 'stopped'; refreshStudio(); await finishRecording(); await refreshMe(); notice('Episode stopped.', true); }
      catch (error) { notice(error.message); }
    });
  });
  $('#fullscreenStage').addEventListener('click', () => $('#stage').requestFullscreen());
  $$('.side-tab').forEach(button => button.addEventListener('click', () => {
    $$('.side-tab').forEach(tab => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-selected', String(tab === button)); });
    $('#transcriptPane').classList.toggle('hidden', button.dataset.side !== 'transcript');
    $('#activityPane').classList.toggle('hidden', button.dataset.side !== 'activity');
  }));
  $('#reviewPlayer').addEventListener('timeupdate', followTranscript);
  $('#captionsToggle').addEventListener('change', event => { for (const track of $('#reviewPlayer').textTracks) track.mode = event.target.checked ? 'showing' : 'hidden'; });
  document.addEventListener('click', event => {
    const seek = event.target.closest('[data-seek]');
    if (seek && seek.closest('#view-studio')) { const player = $('#reviewPlayer'); player.currentTime = Number(seek.dataset.seek) + 0.01; player.play().catch(() => {}); }
    if (event.target.closest('[data-publish-episode]')) openPublishDialog('podcast', state.current, { api, notice, refreshMe, costs: state.config?.costs }).catch(error => notice(error.message));
  });
}
