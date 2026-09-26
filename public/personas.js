import { $, esc, state, api, notice, busy, avatar, person, authHeaders, refreshData, canEdit, confirmDialog, skeleton } from './core.js';

// Persona grid, builder (templates, voice preview, knowledge files and web pages), and test chat.
function populate(select, choices, current) { select.innerHTML = choices.map(([value, label]) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`).join(''); }

export function renderPersonas() {
  const grid = $('#personaGrid');
  if (!state.loaded) { grid.innerHTML = skeleton(3, 'skeleton-card'); return; }
  $('#newPersonaButton').classList.toggle('hidden', !canEdit());
  grid.innerHTML = state.personas.length ? state.personas.map(p => `<article class="persona-card">${avatar(p, true)}<h3>${esc(p.name)}</h3><p>${esc(p.systemPrompt)}</p><div class="persona-card-foot"><span>${p.knowledge?.length || 0} knowledge files${p.knowledgeStats?.semantic ? ' · semantic search' : ''} · ${esc(p.voice)}</span><span class="card-buttons"><button type="button" data-chat="${esc(p.id)}">Test chat</button>${canEdit() ? `<button type="button" data-edit="${esc(p.id)}">Edit</button><button type="button" class="danger-link" data-delete-persona="${esc(p.id)}" aria-label="Delete ${esc(p.name)}">Delete</button>` : ''}</span></div></article>`).join('') : `<div class="empty"><strong>No personas yet</strong>Create a host and a guest to begin.${canEdit() ? '<div class="empty-actions"><button class="button button-primary small" data-onboard="sample-cast">Create a host and a guest for me</button></div>' : ''}</div>`;
}

export function openPersona(existing = null) {
  const form = $('#personaForm'); form.reset(); form.dataset.edit = existing?.id || '';
  $('#personaDialogTitle').textContent = existing ? 'Edit persona' : 'New persona';
  populate($('#modelProvider'), (state.config?.providers.models || []).map(x => [x, x]), existing?.modelProvider || 'gateway');
  populate($('#speechProvider'), (state.config?.providers.speech || []).map(x => [x, x]), existing?.speechProvider || (state.config?.providers.ready.speech.openai ? 'openai' : 'gateway'));
  updateVoiceSuggestions();
  $('#voiceSelect').value = existing?.voice || (state.config?.providers.voices?.[$('#speechProvider').value]?.[0] || '');
  if (existing) for (const key of ['name', 'systemPrompt', 'model', 'voiceStyle']) form.elements[key].value = existing[key] || '';
  form._image = existing?.image || '';
  const stats = new Map((existing?.knowledgeStats?.files || []).map(file => [file.name, file]));
  form._knowledge = (existing?.knowledge || []).map(file => ({ name: file.name, keep: true, characters: file.characters, source: file.source, chunks: stats.get(file.name)?.chunks, embedded: stats.get(file.name)?.embedded }));
  $('#imagePreview').innerHTML = form._image ? `<img src="${esc(form._image)}" alt="Selected display image">` : 'No image selected';
  $('#templateField').classList.toggle('hidden', Boolean(existing));
  loadTemplates().catch(() => {});
  renderKnowledgeList();
  $('#personaDialog').showModal();
}

function renderKnowledgeList() {
  const form = $('#personaForm'), pending = [...form.elements.knowledgeFiles.files].map(file => ({ name: file.name, pendingFile: true, characters: file.size }));
  const files = [...form._knowledge, ...pending];
  $('#knowledgeList').innerHTML = files.length ? files.map((file, index) => `<li><span><strong>${esc(file.name)}</strong> <small>${file.pendingFile ? 'will be read on save' : `${Math.round((file.characters || file.text?.length || 0) / 1000)}k characters${file.chunks ? ` · ${file.chunks} passages${file.embedded ? ', searchable by meaning' : ''}` : file.keep ? '' : ' · new'}`}${file.source ? ` · <a href="${esc(file.source)}" target="_blank" rel="noopener">source</a>` : ''}</small></span>${file.pendingFile ? '' : `<button type="button" class="icon-button" data-remove-knowledge="${index}" aria-label="Remove ${esc(file.name)}">×</button>`}</li>`).join('') : '<li class="hint">No knowledge yet. Add files or web pages the persona should draw on.</li>';
}

async function loadTemplates() {
  if (!state.templates) state.templates = await api('/api/persona-templates');
  $('#personaTemplate').innerHTML = '<option value="">Blank persona</option>' + state.templates.map(template => `<option value="${esc(template.id)}">${esc(template.label)}</option>`).join('');
}

async function previewVoice(button) {
  const form = $('#personaForm');
  await busy(button, async () => {
    try {
      const response = await fetch('/api/voices/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', ...await authHeaders() }, body: JSON.stringify({ speechProvider: form.elements.speechProvider.value, voice: form.elements.voice.value, voiceStyle: form.elements.voiceStyle.value, name: form.elements.name.value }) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'The voice preview failed.');
      await new Audio(URL.createObjectURL(await response.blob())).play();
    } catch (error) { notice(error.message); }
  }, 'Generating…');
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
  form.elements.message.value = '';
  await busy(button, async () => {
    try {
      const result = await api(`/api/personas/${form.dataset.personaId}/chat`, { method: 'POST', body: JSON.stringify({ message, history: form._history }) });
      form._history.push({ role: 'tester', text: message }, { role: 'persona', text: result.reply });
      log.insertAdjacentHTML('beforeend', `<div class="chat-line persona"><strong>${esc(name)}</strong><p>${esc(result.reply)}</p>${result.sources.length ? `<small class="sources">Sources: ${result.sources.map(esc).join(', ')}</small>` : result.retrieved.length ? '<small class="sources">No knowledge file was cited.</small>' : ''}</div>`);
    } catch (error) { log.insertAdjacentHTML('beforeend', `<div class="chat-line error">${esc(error.message)}</div>`); }
  });
  log.scrollTop = log.scrollHeight; form.elements.message.focus();
}

function updateVoiceSuggestions() {
  const voices = state.config?.providers.voices?.[$('#speechProvider').value] || [];
  $('#voiceSuggestions').innerHTML = voices.map(voice => `<option value="${esc(voice)}"></option>`).join('');
}

async function extractFile(file) {
  if (/\.(txt|md|csv|json)$/i.test(file.name)) return file.text();
  const response = await fetch(`/api/extract?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', ...await authHeaders() }, body: file });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Could not read ${file.name}`);
  return data.text;
}

async function savePersona(event) {
  event.preventDefault();
  const form = event.currentTarget;
  await busy(form.querySelector('[type=submit]'), async () => {
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
      $('#personaDialog').close(); await refreshData(); notice('Persona saved.', true);
    } catch (error) { notice(error.message); }
  }, 'Saving…');
}

async function deletePersona(id) {
  const p = person(id);
  if (!p || !await confirmDialog({ title: `Delete ${p.name}?`, message: 'Existing episodes keep their copy of this persona. New episodes can no longer use it.', confirm: 'Delete persona', danger: true })) return;
  try { await api(`/api/personas/${id}`, { method: 'DELETE' }); await refreshData(); notice('Persona deleted.', true); } catch (error) { notice(error.message); }
}

export function initPersonas() {
  $('#newPersonaButton').addEventListener('click', () => openPersona());
  $('#personaForm').addEventListener('submit', savePersona);
  $('#personaForm').elements.imageFile.addEventListener('change', event => { const file = event.target.files[0]; if (file) $('#imagePreview').innerHTML = `<img src="${URL.createObjectURL(file)}" alt="Image preview">`; });
  $('#personaForm').elements.knowledgeFiles.addEventListener('change', renderKnowledgeList);
  $('#speechProvider').addEventListener('change', () => { updateVoiceSuggestions(); $('#voiceSelect').value = state.config?.providers.voices?.[$('#speechProvider').value]?.[0] || ''; });
  $('#previewVoice').addEventListener('click', event => previewVoice(event.currentTarget));
  $('#chatForm').addEventListener('submit', sendChat);
  $('#personaTemplate').addEventListener('change', event => {
    const template = state.templates?.find(entry => entry.id === event.target.value), form = $('#personaForm');
    if (!template) return;
    for (const key of ['name', 'systemPrompt', 'voiceStyle']) form.elements[key].value = template[key];
    form.elements.voice.value = template.voice;
  });
  $('#addKnowledgeUrl').addEventListener('click', event => {
    const form = $('#personaForm'), target = form.elements.knowledgeUrl.value.trim();
    if (!target) { notice('Paste a public web page address first.'); return; }
    busy(event.currentTarget, async () => {
      try { const page = await api('/api/extract-url', { method: 'POST', body: JSON.stringify({ url: target }) }); form._knowledge.push(page); form.elements.knowledgeUrl.value = ''; renderKnowledgeList(); notice(`Added “${page.name}”. Save the persona to index it.`, true); }
      catch (error) { notice(error.message); }
    }, 'Reading…');
  });
  document.addEventListener('click', event => {
    const remove = event.target.closest('[data-remove-knowledge]'); if (remove) { $('#personaForm')._knowledge.splice(Number(remove.dataset.removeKnowledge), 1); renderKnowledgeList(); }
    const chat = event.target.closest('button[data-chat]'); if (chat) openChat(person(chat.dataset.chat));
    const edit = event.target.closest('button[data-edit]'); if (edit) openPersona(person(edit.dataset.edit));
    const del = event.target.closest('[data-delete-persona]'); if (del) deletePersona(del.dataset.deletePersona);
  });
}
