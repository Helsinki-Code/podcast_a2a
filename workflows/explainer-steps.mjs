import { notifyOwner } from '../lib/notify.mjs';
import { captureError } from '../lib/monitor.mjs';
import { enterUsage } from '../lib/usage.mjs';
import { explainer, setExplainerFields, putNamedAsset, readAssetBytes, refundCredits, stamp } from '../lib/store.mjs';
import { modelProviders, speechProviders, supportedVoice } from '../lib/providers.mjs';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';
import { inspectSandboxMedia, evaluateMediaQuality } from '../lib/media-quality.mjs';
import { focusFilters } from '../lib/explainer-effects.mjs';
import { modelFor } from '../lib/models.mjs';
import { ffmetadata, normalizeChapters, titleFromText } from '../lib/chapters.mjs';
import { generatedMusicSource, titleMusicFilter } from '../lib/podcast-media.mjs';
import { generateMetadata, packageVideo } from '../lib/publish-media.mjs';

const safeName = value => String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
const srtText = text => String(text).replace(/\r?\n/g, ' ').replace(/<[^>]+>/g, '');
const consequentialControl = value => /\b(?:launch(?:\s+sending|\s+campaign)?|send(?:\s+now)?|approve\s+all|purchase|pay|subscribe|delete|remove|publish|post|archive|stop\s+campaign|clear\s+failures|retry\s+send)\b/i.test(String(value || ''));
const validHex = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;
const assColor = (hex, alpha = '00') => {
  const value = validHex(hex, '#ffffff').slice(1);
  return `&H${alpha}${value.slice(4, 6)}${value.slice(2, 4)}${value.slice(0, 2)}`;
};
export function explainerCaptionFilter(input = 'studio', subtitlePath = '/tmp/captions.srt') {
  const options = typeof input === 'string' ? { style: input } : (input || {});
  const styles = {
    studio: 'FontName=DejaVu Sans,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H70000000,BackColour=&H70000000,BorderStyle=3,Outline=1,Shadow=0,Alignment=2,MarginV=52',
    minimal: 'FontName=DejaVu Sans,FontSize=19,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BackColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=50',
    editorial: 'FontName=DejaVu Serif,FontSize=17,PrimaryColour=&H00FFFFFF,OutlineColour=&H85000000,BackColour=&H85000000,BorderStyle=3,Outline=1,Shadow=0,Alignment=2,MarginV=58',
    bold: 'FontName=DejaVu Sans,FontSize=23,Bold=1,PrimaryColour=&H0019E6FF,OutlineColour=&H00101010,BackColour=&H40000000,BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=48'
  };
  if (!options.font && !options.size && !options.textColor && !options.backgroundColor && !options.position) return `subtitles=${subtitlePath}:force_style='${styles[options.style] || styles.studio}'`;
  const fonts = { sans: 'DejaVu Sans', serif: 'DejaVu Serif', mono: 'DejaVu Sans Mono' };
  const alignment = { bottom: 2, center: 5, top: 8 }[options.position] || 2;
  const margin = alignment === 2 ? 52 : alignment === 8 ? 48 : 0;
  const fontSize = Math.max(14, Math.min(32, Number(options.size) || 18));
  const primary = assColor(options.textColor, '00');
  const background = assColor(options.backgroundColor, options.style === 'minimal' ? 'FF' : '70');
  const borderStyle = options.style === 'minimal' || options.style === 'bold' ? 1 : 3;
  const outline = options.style === 'bold' ? 3 : options.style === 'minimal' ? 2 : 1;
  const bold = options.style === 'bold' ? 1 : 0;
  return `subtitles=${subtitlePath}:force_style='FontName=${fonts[options.font] || fonts.sans},FontSize=${fontSize},Bold=${bold},PrimaryColour=${primary},OutlineColour=&H00101010,BackColour=${background},BorderStyle=${borderStyle},Outline=${outline},Shadow=0,Alignment=${alignment},MarginV=${margin}'`;
}
function srtTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const hours = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const minutes = String(Math.floor(ms % 3600000 / 60000)).padStart(2, '0');
  const secs = String(Math.floor(ms % 60000 / 1000)).padStart(2, '0');
  return `${hours}:${minutes}:${secs},${String(ms % 1000).padStart(3, '0')}`;
}

export function captionChunks(text, maxWords = 7, maxCharacters = 52) {
  const words = srtText(text).trim().split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = [];
  for (const word of words) {
    const candidate = [...current, word];
    if (current.length && (candidate.length > maxWords || candidate.join(' ').length > maxCharacters)) {
      chunks.push(current.join(' '));
      current = [word];
    } else current = candidate;
  }
  if (current.length) chunks.push(current.join(' '));
  return chunks;
}

export function buildCaptions(timeline, options = {}) {
  let cursor = Math.max(0, Number(options.offset) || 0);
  let cue = 1;
  const entries = [];
  for (const part of timeline) {
    const chunks = captionChunks(part.text, Math.max(3, Math.min(10, Number(options.wordsPerCue) || 7)));
    const weights = chunks.map(chunk => chunk.split(/\s+/).length);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
    let sceneCursor = cursor;
    chunks.forEach((chunk, index) => {
      const captionDuration = Math.min(part.duration, Number(part.captionDuration) || part.duration);
      const end = index === chunks.length - 1 ? cursor + captionDuration : sceneCursor + captionDuration * weights[index] / totalWeight;
      entries.push(`${cue++}\n${srtTime(sceneCursor)} --> ${srtTime(end)}\n${chunk}\n`);
      sceneCursor = end;
    });
    cursor += part.duration;
  }
  return entries.join('\n');
}

export function actionFingerprint(action = {}) {
  const type = String(action.type || 'wait');
  if (type === 'wait') return 'wait';
  if (type === 'scroll') return `scroll:${action.direction === 'up' ? 'up' : 'down'}`;
  if (type === 'visit') return `visit:${String(action.url || '').replace(/\/$/, '')}`;
  if (['click','double_click','right_click','type','drag'].includes(type) && action.selector) return `${type}:${String(action.selector)}:${String(action.text || action.value || '')}`;
  if (['click','double_click','right_click','type','drag'].includes(type) && Number.isFinite(Number(action.x)) && Number.isFinite(Number(action.y))) return `${type}:${Math.round(Number(action.x) / 24)}:${Math.round(Number(action.y) / 24)}:${String(action.text || action.value || '')}`;
  return `${type}:${String(action.selector || '')}:${String(action.value || action.key || '')}`;
}

const targetRoles = {
  click: ['link','button','checkbox','radio','tab','menuitem','option'],
  type: ['textbox','searchbox','input','textarea','combobox'],
  select: ['combobox','listbox','option','select'],
  press: ['button','textbox','searchbox','combobox','slider','spinbutton','tab']
};
const tagRoles = { a: 'link', button: 'button', input: 'textbox', textarea: 'textbox', select: 'combobox', option: 'option' };
const rolesForAction = type => targetRoles[['double_click','right_click','drag'].includes(type) ? 'click' : type === 'fill' ? 'type' : type] || [];
const normalizedName = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

function snapshotElements(screen = {}) {
  return String(screen.content || '').split('\n').map(line => {
    const ref = line.match(/\bref=(e\d+)\b/)?.[1];
    const match = line.match(/^\s*-\s*([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/i);
    return ref && match ? { ref, role: match[1].toLowerCase(), name: (match[2] || '').replace(/\\"/g, '"'), line: line.trim() } : null;
  }).filter(Boolean);
}

export function compatibleTargets(type, screen = {}, limit = 12) {
  const roles = rolesForAction(String(type || ''));
  return snapshotElements(screen).filter(element => roles.includes(element.role) && !consequentialControl(element.line)).slice(0, limit).map(element => `@${element.ref} ${element.role} "${element.name}"`);
}

// Models sometimes answer with CSS, Playwright text selectors, or bare refs instead of the
// @eN reference from the accessibility snapshot. Map those back onto the snapshot element.
export function resolveActionTarget(action = {}, screen = {}) {
  if (!action || typeof action !== 'object') return action;
  const selector = String(action.selector || '').trim();
  if (!selector || /^@e\d+$/.test(selector)) return action;
  const bareRef = selector.match(/^(?:@|ref=|\[ref=)?(e\d+)\]?$/)?.[1];
  const elements = snapshotElements(screen);
  if (bareRef && elements.some(element => element.ref === bareRef)) return { ...action, selector: `@${bareRef}` };
  const roles = rolesForAction(String(action.type || ''));
  if (!roles.length) return action;
  const names = [...selector.matchAll(/(?:aria-label|title|placeholder|name|value|alt)\s*[*^$~|]?=\s*(['"])(.*?)\1/gi)].map(match => match[2]);
  names.push(...[...selector.matchAll(/(?:has-text|text|contains)\s*\(\s*(['"])(.*?)\1\s*\)/gi)].map(match => match[2]));
  names.push(...[...selector.matchAll(/text\s*=\s*(['"]?)([^'"]+)\1/gi)].map(match => match[2]));
  if (!names.length) names.push(...[...selector.matchAll(/(['"])(.+?)\1/g)].map(match => match[2]));
  if (!names.length && !/[#.\[\]>:=()]/.test(selector)) names.push(selector);
  const tag = selector.match(/^([a-z]+)(?=[\[.#:\s]|$)/i)?.[1]?.toLowerCase();
  const explicitRole = selector.match(/role\s*=\s*['"]?([a-z]+)/i)?.[1]?.toLowerCase();
  const preferredRole = explicitRole || tagRoles[tag];
  const candidates = elements.filter(element => roles.includes(element.role));
  const rank = element => (preferredRole && element.role === preferredRole ? 0 : 1);
  for (const matches of [(element, name) => normalizedName(element.name) === name, (element, name) => normalizedName(element.name).includes(name)]) {
    for (const name of names.map(normalizedName).filter(Boolean)) {
      const found = candidates.filter(element => matches(element, name)).sort((a, b) => rank(a) - rank(b))[0];
      if (found) return { ...action, selector: `@${found.ref}` };
    }
  }
  return action;
}

export function actionIsCompatible(action = {}, screen = {}) {
  const type = String(action.type || 'wait');
  if (process.env.COMPUTER_USE_SNAPSHOT_ID) {
    if (['wait','scroll','visit','key'].includes(type)) return type !== 'visit' || /^https?:\/\//i.test(action.url || '');
    if (!['click','double_click','right_click','type','drag'].includes(type)) return false;
    const selector = String(action.selector || '');
    if (/^@[a-zA-Z0-9_-]+$/.test(selector)) {
      const ref = selector.slice(1);
      const line = String(screen.content || '').split('\n').find(value => value.includes(`[ref=${ref}]`)) || '';
      if (!line) return false;
      if (['click','double_click'].includes(type) && /\b(?:launch(?:\s+sending|\s+campaign)?|send(?:\s+now)?|approve\s+all|purchase|pay|subscribe|delete|remove|publish|post|archive|stop\s+campaign|clear\s+failures|retry\s+send)\b/i.test(line)) return false;
      if (['click','double_click','right_click'].includes(type)) return /\b(link|button|checkbox|radio|tab|menuitem|option)\b/i.test(line);
      if (type === 'type') return /\b(textbox|searchbox|input|textarea|combobox)\b/i.test(line) && Boolean(String(action.text || action.value || '').trim());
    }
    if (['click','double_click'].includes(type) && consequentialControl(screen.content)) return false;
    const x = Number(action.x), y = Number(action.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x >= 1920 || y < 0 || y >= 1080) return false;
    if (type === 'drag') return Number.isFinite(Number(action.endX)) && Number.isFinite(Number(action.endY));
    return type !== 'type' || Boolean(String(action.text || action.value || '').trim());
  }
  if (['wait','scroll','visit'].includes(type)) return true;
  const ref = String(action.selector || '').replace(/^@/, '');
  const line = String(screen.content || '').split('\n').find(value => value.includes(`[ref=${ref}]`)) || '';
  if (!line) return false;
  if (type === 'click' && /\b(?:launch(?:\s+sending|\s+campaign)?|send(?:\s+now)?|approve\s+all|purchase|pay|subscribe|delete|remove|publish|post|archive|stop\s+campaign|clear\s+failures|retry\s+send)\b/i.test(line)) return false;
  if (type === 'click') return /\b(link|button|checkbox|radio|tab|menuitem|option)\b/i.test(line);
  if (type === 'type' || type === 'fill') return /\b(textbox|searchbox|input|textarea|combobox)\b/i.test(line);
  if (type === 'select') return /\b(combobox|listbox|option|select)\b/i.test(line);
  if (type === 'press') return /\b(button|textbox|searchbox|combobox|slider|spinbutton|tab)\b/i.test(line);
  return false;
}

export async function normalizeSceneVideo(browser, inputPath, outputPath, duration, options = {}) {
  const length = String(Math.max(2, Math.min(40, Number(duration) || 8)));
  const sourceProbe = await browser.run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath]);
  const sourceDuration = Number((await sourceProbe.stdout()).trim()) || Number(length);
  const playbackRatio = Math.max(.2, Math.min(4, Number(length) / sourceDuration));
  // Zoom and highlight run on source timestamps, before the scene is retimed to the narration.
  const emphasis = options.focus ? ['scale=1920:1080', ...focusFilters(options.focus, options.clickAt, options.effects || {})] : [];
  const videoFilter = [...emphasis, `setpts=${playbackRatio.toFixed(6)}*PTS`, 'scale=1920:1080:force_original_aspect_ratio=decrease', 'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black', 'fps=30'].join(',');
  let result = await browser.run('ffmpeg', ['-y', '-fflags', '+genpts', '-i', inputPath, '-t', length, '-an', '-vf', videoFilter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath], 10 * 60 * 1000);
  if (result.exitCode) throw new Error(`The live browser recording is invalid and cannot be used: ${(await result.stderr()).slice(-1200)}`);
  const metrics = await inspectSandboxMedia(browser, outputPath, { sceneThreshold: 0.008, ignoreCaptionBand: false });
  if (!metrics.video || metrics.duration < 1 || (options.requireMotion !== false && metrics.uniqueFrames < 2)) throw new Error('The live browser recording is empty or effectively frozen.');
  return { path: outputPath, usedScreenshotFallback: false, metrics };
}

export async function beginExplainer(id) {
  'use step';
  const item = await explainer(id);
  await setExplainerFields(id, { status: 'running', startedAt: stamp(), progress: 'Opening the application', error: null });
  const browser = new VercelEpisodeSandbox(id, () => {});
  await browser.setViewport(1920, 1080);
  if (!item.authRequired) await browser.command(['open', item.url]);
  await browser.dismissOverlays();
  return browser.capture(null, item.url);
}

export function sceneBudgetFor(item) {
  if (item?.plan?.approved && item.plan.scenes?.length) return Math.max(1, Math.min(20, item.plan.scenes.length));
  const words = String(item?.brief || '').trim().split(/\s+/).filter(Boolean).length;
  const explicitSteps = (String(item?.brief || '').match(/(?:^|\n)\s*(?:\d+[.)]|[-*])\s+/g) || []).length;
  return Math.max(4, Math.min(20, explicitSteps ? explicitSteps + 3 : Math.ceil(words / 14) + 4));
}

export async function explainerSceneBudget(id) {
  'use step';
  return sceneBudgetFor(await explainer(id));
}

export function requiredActionKinds(brief = '') {
  const text = String(brief).toLowerCase();
  const required = [];
  if (/\bscroll(?:ing|ed)?\b/.test(text)) required.push('scroll');
  if (/\b(?:type|typing|enter|fill|write)\b/.test(text)) required.push('type');
  if (/\b(?:click|open|navigate|select|choose)\b/.test(text)) required.push('navigate');
  return required;
}

export function explainerActionKind(action = {}) {
  return ['click','double_click','right_click','visit','select','press'].includes(action.type) ? 'navigate' : String(action.type || 'wait');
}

export function buildExplainerDirectorState(requiredKinds, timeline, history, screen, index, sceneBudget) {
  const completedMilestones = [...new Set(timeline.map(part => explainerActionKind(part.action)))];
  const requestedMilestones = [...new Set(requiredKinds)];
  return {
    requestedMilestones,
    completedMilestones,
    remainingMilestones: requestedMilestones.filter(kind => !completedMilestones.includes(kind)),
    previousActions: history.filter(entry => entry.action).map(entry => ({ action: entry.action, narration: entry.narration, screenChanged: entry.screenChanged })),
    rejectedDecisions: history.filter(entry => entry.rejected).slice(-6).map(entry => entry.rejected),
    currentScreen: { title: screen.title, accessibility: screen.content },
    scene: { number: index + 1, completedScenes: timeline.length, estimatedBudget: sceneBudget, estimatedBudgetReached: index >= sceneBudget - 1 },
    allowedActions: process.env.COMPUTER_USE_SNAPSHOT_ID
      ? ['click','double_click','right_click','type','key','scroll','drag','visit','wait']
      : ['click','type','select','press','scroll','visit','wait'],
    forbiddenControls: ['send','pay','purchase','subscribe','delete','remove','publish','post','launch','approve all','archive','stop campaign','clear failures']
  };
}

export async function explainerRequirements(id) {
  'use step';
  const item = await explainer(id);
  return requiredActionKinds(item?.brief);
}

export async function planScene(id, directorState) {
  'use step';
  const item = await explainer(id);
  enterUsage({ ownerId: item?.ownerId, kind: 'explainer', id: id });
  await setExplainerFields(id, { progress: `Directing scene ${directorState.scene.number}` });
  const provider = modelProviders.get('gateway');
  const computerUse = Boolean(process.env.COMPUTER_USE_SNAPSHOT_ID);
  const system = computerUse
    ? `You direct a continuous product walkthrough by looking at a 1920x1080 screenshot and operating the visible desktop like a careful human. Return one JSON object with narration, action, and done. Actions: {"type":"click","selector":"@e2","x":500,"y":300}, {"type":"double_click","selector":"@e2","x":500,"y":300}, {"type":"right_click","selector":"@e2","x":500,"y":300}, {"type":"type","selector":"@e4","x":500,"y":300,"text":"visible demo value"}, {"type":"key","key":"Return"}, {"type":"scroll","direction":"down","amount":5}, {"type":"drag","x":400,"y":300,"endX":800,"endY":300}, {"type":"visit","url":"https://..."}, or {"type":"wait","ms":800}. Coordinates refer to the supplied screenshot. When the accessibility snapshot contains the intended web control, include its exact @e ref as selector (never a CSS, XPath, or text selector) and also provide the visible approximate coordinates. Use coordinates alone for canvas, remote desktop, or other targets without a ref. The screenshot is primary visual context; the ref anchors small targets reliably. Use an ordinary left click for web links, buttons, and controls. Use double click, right click, or drag only when the requested workflow explicitly requires that gesture. Every scene must advance the requested workflow or reveal a new part of the interface. Never repeat an action, screen, named section, typed field, or narration. After one scroll, interact with a newly visible control or finish. Prefer one safe reversible visible interaction in each scene. Keep narration between 12 and 28 words and introduce the action that happens during the sentence. Never delete, purchase, publish, send messages, change account settings, log out, or submit irreversible forms. Set done true as soon as the requested coverage is complete. Do not mention automation, coordinates, credentials, or that you are an AI.`
    : `You direct a continuous, human-operated premium product walkthrough. Return one JSON object with narration, action, and done. The action is one of: {"type":"click","selector":"@e1"}, {"type":"type","selector":"@e1","value":"visible demo value"}, {"type":"select","selector":"@e1","value":"option value"}, {"type":"press","selector":"@e1","key":"ArrowRight"}, {"type":"scroll","direction":"down","amount":900}, {"type":"visit","url":"https://..."}, or {"type":"wait","ms":800}. Use only element refs visible in the current accessibility snapshot, written exactly as @eN; never use CSS, XPath, or text selectors. Click only refs labeled link, button, checkbox, radio, tab, menuitem, or option. Type only into refs labeled textbox, searchbox, input, textarea, or combobox. Every scene must advance the requested workflow or reveal a new part of the interface. Never repeat any prior action, screen, named section, typed field, or narration. One scroll scene is enough to reveal a section; after scrolling, interact with a new visible control or set done true. Prefer one visible, reversible interaction in every scene; use wait only for the opening or final wrap-up. Use type rather than fill so real keystrokes appear in the recording. Keep narration between 12 and 28 words and time it as a human explanation of the action occurring now. Describe only what is visible or what this scene's action will visibly demonstrate. Stay read-only unless the user's brief explicitly requires a safe reversible submission: never delete, submit payments, change account settings, log out, send messages, or publish content. Set done true immediately after the requested workflow has been covered. Do not mention automation, selectors, credentials, or that you are an AI.`;
  const planned = item.plan?.approved ? item.plan.scenes || [] : [];
  const current = planned[directorState.scene.completedScenes];
  const planGuidance = planned.length ? `\nApproved scene plan (follow it in order):\n${planned.map((scene, i) => `${i + 1}. ${scene.title} — goal: ${scene.goal} — narration: ${scene.narration}`).join('\n')}\n${current ? `You are on planned scene ${directorState.scene.completedScenes + 1}: "${current.title}". Achieve its goal with one visible action and use its narration nearly word for word, adjusting only what the screen makes untrue.` : 'Every planned scene is recorded; set done true with a short closing line.'}` : '';
  const context = `Application: ${item.url}\nRequested coverage: ${item.brief}${planGuidance}\nDirector state:\n${JSON.stringify(directorState)}\nChoose the next action from allowedActions. Use remainingMilestones to decide what the walkthrough still needs. Prioritize the first remaining milestone before optional exploration whenever the current screen can perform it. A milestone counts only after a recorded action visibly completes it.${directorState.scene.estimatedBudgetReached && directorState.remainingMilestones.length ? ` The next action must satisfy one of these remaining milestones: ${directorState.remainingMilestones.join(', ')}.` : ''} Set done true only when remainingMilestones is empty and this scene completes the requested coverage.`;
  const model = modelFor('explainer');
  const routing = { user: item.ownerId, tags: ['feature:explainer-director', `mode:${computerUse ? 'computer-use' : 'browser'}`] };
  const sandbox = new VercelEpisodeSandbox(id, () => {});
  await sandbox.dismissOverlays();
  const withTitle = decision => (current && decision && typeof decision === 'object' ? { ...decision, title: current.title } : decision);
  if (!computerUse) return withTitle(await provider.generate([{ role: 'system', content: system }, { role: 'user', content: context }], model, routing));
  const capture = await sandbox.captureForModel(item.url);
  return withTitle(await provider.generateVisual([{ role: 'system', content: system }, { role: 'user', content: `${context}\nThe attached image is the current live desktop screenshot.` }], capture.image, model, routing));
}

export async function renderScene(id, index, narration, action) {
  'use step';
  const item = await explainer(id);
  enterUsage({ ownerId: item?.ownerId, kind: 'explainer', id: id });
  await setExplainerFields(id, { progress: `Recording scene ${index + 1}` });
  const browser = new VercelEpisodeSandbox(id, () => {});
  const speechProvider = item.speechProvider || 'gateway';
  const speech = speechProviders.get(speechProvider);
  if (!speech) throw new Error('The narration voice provider is unavailable.');
  const generated = await speech.synthesize(narration, supportedVoice(speechProvider, item.voice, 'coral'));
  const chunks = [];
  for await (const chunk of Buffer.isBuffer(generated) || generated instanceof Uint8Array ? [generated] : generated) chunks.push(Buffer.from(chunk));
  const audioPath = `/tmp/explainer-${index}.mp3`;
  const rawVideoPath = `/tmp/explainer-${index}.webm`;
  const videoPath = `/tmp/explainer-${index}.mp4`;
  await browser.writeSandboxFile(audioPath, Buffer.concat(chunks));
  const probe = await browser.run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath]);
  const speechDuration = Math.max(2, Math.min(40, Number((await probe.stdout()).trim()) || 8));
  const recordingStarted = Date.now();
  let performed = null, clickAt = 0;
  await browser.startVideo(rawVideoPath);
  try {
    await browser.command(['wait', '450']);
    performed = browser.computerUseEnabled() ? await browser.performComputerAction(action) : await browser.performBrowserAction(action);
    // The click lands just before the executor's short post-action pause.
    clickAt = Math.max(0.3, (Date.now() - recordingStarted) / 1000 - 0.6);
    const remaining = speechDuration * 1000 - (Date.now() - recordingStarted);
    if (remaining > 0) await browser.command(['wait', String(Math.ceil(Math.max(500, remaining)))]);
  } finally {
    await browser.stopVideo().catch(() => {});
  }
  const screen = await browser.capture(null, item.url);
  const duration = speechDuration;
  const effects = { zoom: item.effects?.zoom !== false, highlight: item.effects?.highlight !== false };
  const focus = (effects.zoom || effects.highlight) && ['click','double_click','right_click','type','fill','select','press'].includes(action.type) ? performed?.focus : null;
  const normalized = await normalizeSceneVideo(browser, rawVideoPath, videoPath, duration, { requireMotion: action.type !== 'wait', focus, clickAt, effects });
  // Keep each finished scene so narration, voice, and captions can be re-rendered without re-recording.
  const sceneAsset = await putNamedAsset(`explainer-${safeName(id)}-scene-${index}.mp4`, await browser.readSandboxFile(videoPath));
  const paddedAudioPath = `/tmp/explainer-${index}.m4a`;
  const padded = await browser.run('ffmpeg', ['-y', '-i', audioPath, '-af', 'apad', '-t', String(duration), '-c:a', 'aac', '-b:a', '192k', paddedAudioPath], 5 * 60 * 1000);
  if (padded.exitCode) throw new Error(`Could not align narration with the recorded action: ${(await padded.stderr()).slice(-1000)}`);
  return { duration, captionDuration: speechDuration, video: normalized.path, audio: paddedAudioPath, screen, action, usedScreenshotFallback: normalized.usedScreenshotFallback, metrics: normalized.metrics, sceneAsset };
}

// Brand title card for the start or end of an explainer: a still frame with a short music sting.
async function explainerCard(browser, item, kind, seconds) {
  const brand = item.brand || {};
  const logo = brand.logo ? await readAssetBytes(brand.logo).catch(() => null) : null;
  const logoData = logo?.length ? `data:image/${/\.svg$/i.test(brand.logo) ? 'svg+xml' : /\.jpe?g$/i.test(brand.logo) ? 'jpeg' : /\.webp$/i.test(brand.logo) ? 'webp' : 'png'};base64,${logo.toString('base64')}` : '';
  const primary = validHex(brand.primaryColor, '#101c24'), accent = validHex(brand.accentColor, '#80ded1');
  const escape = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const heading = kind === 'intro' ? escape(item.title) : escape(brand.outroText || 'Thanks for watching');
  const line = kind === 'intro' ? escape(brand.name || '') : escape(brand.callToAction || '');
  const markup = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:1920px;height:1080px;background:${primary};color:#fff;font-family:Arial,sans-serif;display:grid;place-items:center;text-align:center}img{max-height:150px;max-width:520px;margin-bottom:48px}h1{font-size:84px;margin:0 160px 28px;line-height:1.05}p{font-size:34px;color:${accent};margin:0;letter-spacing:2px}</style><div>${logoData ? `<img src="${logoData}">` : ''}<h1>${heading}</h1><p>${line}</p></div>`;
  const htmlPath = `/tmp/explainer-${kind}.html`, pngPath = `/tmp/explainer-${kind}.png`;
  await browser.writeSandboxFile(htmlPath, markup);
  await browser.command(['open', `file://${htmlPath}`]);
  await browser.command(['wait', '250']);
  await browser.command(['screenshot', pngPath]);
  const videoPath = `/tmp/explainer-${kind}.mp4`, audioPath = `/tmp/explainer-${kind}.m4a`;
  let result = await browser.run('ffmpeg', ['-y', '-loop', '1', '-framerate', '30', '-i', pngPath, '-t', seconds.toFixed(2), '-vf', `scale=1920:1080,fps=30,format=yuv420p,fade=t=in:d=0.4,fade=t=out:st=${(seconds - 0.5).toFixed(2)}:d=0.5`, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', videoPath], 5 * 60 * 1000);
  if (result.exitCode) throw new Error(`Could not render the ${kind} card: ${(await result.stderr()).slice(-800)}`);
  result = await browser.run('ffmpeg', ['-y', '-f', 'lavfi', '-i', generatedMusicSource(seconds), '-af', titleMusicFilter(seconds), '-c:a', 'aac', '-b:a', '192k', audioPath], 5 * 60 * 1000);
  if (result.exitCode) throw new Error(`Could not render the ${kind} sound: ${(await result.stderr()).slice(-800)}`);
  return { video: videoPath, audio: audioPath, duration: seconds };
}

// Shared by the first render and by re-renders: cards, captions, chapters, mix, quality check, upload.
async function mixExplainer(browser, id, item, timeline, { variant = '' } = {}) {
  await setExplainerFields(id, { progress: 'Mixing narration, picture, and subtitles' });
  const branding = item.branding || {};
  const intro = branding.intro && item.brand ? await explainerCard(browser, item, 'intro', 3.5) : null;
  const outro = branding.outro && item.brand ? await explainerCard(browser, item, 'outro', 4) : null;
  const pieces = [...(intro ? [intro] : []), ...timeline, ...(outro ? [outro] : [])];
  const captionOptions = { style: item.captionStyle || 'studio', ...(item.captionOptions || {}), offset: intro?.duration || 0 };
  const captions = buildCaptions(timeline, captionOptions);
  const metadata = variant ? null : await generateMetadata('explainer', item, timeline.map(part => ({ text: part.text })));
  let cursor = intro?.duration || 0;
  const rawChapters = [];
  if (intro) rawChapters.push({ start: 0, title: 'Introduction' });
  timeline.forEach((part, index) => { rawChapters.push({ start: cursor, title: part.title || metadata?.chapterTitles?.[index] || titleFromText(part.text) }); cursor += part.duration; });
  const totalDuration = pieces.reduce((sum, part) => sum + part.duration, 0);
  const chapters = normalizeChapters(rawChapters, totalDuration);
  await browser.writeSandboxFile('/tmp/videos.txt', pieces.map(part => `file '${part.video}'`).join('\n'));
  await browser.writeSandboxFile('/tmp/audio.txt', pieces.map(part => `file '${part.audio}'`).join('\n'));
  await browser.writeSandboxFile('/tmp/captions.srt', captions);
  await browser.writeSandboxFile('/tmp/chapters.txt', ffmetadata(chapters, totalDuration, { title: item.title, comment: metadata?.description }));
  let result = await browser.run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', '/tmp/videos.txt', '-an', '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '/tmp/picture.mp4'], 10 * 60 * 1000);
  if (result.exitCode) throw new Error(`Could not assemble browser recording: ${(await result.stderr()).slice(-1200)}`);
  result = await browser.run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', '/tmp/audio.txt', '-c:a', 'aac', '-b:a', '192k', '/tmp/narration.m4a'], 10 * 60 * 1000);
  if (result.exitCode) throw new Error(`Could not assemble narration: ${(await result.stderr()).slice(-1200)}`);
  const finalArgs = ['-y', '-i', '/tmp/picture.mp4', '-i', '/tmp/narration.m4a', '-i', '/tmp/chapters.txt', '-map', '0:v', '-map', '1:a', '-map_metadata', '2', '-map_chapters', '2', ...(captionOptions.enabled === false ? [] : ['-vf', explainerCaptionFilter(captionOptions)]), '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-shortest', '/tmp/final.mp4'];
  result = await browser.run('ffmpeg', finalArgs, 15 * 60 * 1000);
  if (result.exitCode) throw new Error(`Could not render the final video: ${(await result.stderr()).slice(-1200)}`);
  const quality = await inspectSandboxMedia(browser, '/tmp/final.mp4', { sceneThreshold: 0.008 });
  const interactiveActions = timeline.filter(part => !['wait'].includes(part.action?.type));
  quality.sceneChanges = interactiveActions.filter(part => part.screenChanged).length;
  quality.uniqueFrames = interactiveActions.reduce((sum, part) => sum + Number(part.metrics?.uniqueFrames || 0), 0);
  const verdict = evaluateMediaQuality(quality, { interactive: interactiveActions.length > 0, minDuration: Math.max(4, timeline.length * 1.5), maxSilencePercent: 35, maxSilenceSeconds: 2 });
  if (!verdict.passed) throw new Error(`Explainer quality check failed: ${verdict.failures.join(' ')}`);
  const stem = `explainer-${safeName(id)}${item.renderVersion ? `-v${item.renderVersion}` : ''}${variant ? `-${safeName(variant)}` : ''}`;
  let exportCursor = intro?.duration || 0;
  const exportTimeline = timeline.map(part => { const entry = { speaker: '', text: part.text, start: Number(exportCursor.toFixed(3)), duration: Number(Math.min(part.duration, Number(part.captionDuration) || part.duration).toFixed(3)) }; exportCursor += part.duration; return entry; });
  const packaged = variant ? {} : await packageVideo(browser, { kind: 'explainer', item, finalPath: '/tmp/final.mp4', timeline: exportTimeline, totalDuration, chapters, stem, accent: item.brand?.accentColor || '#80ded1', metadata });
  const [video, srt] = await Promise.all([browser.readSandboxFile('/tmp/final.mp4'), browser.readSandboxFile('/tmp/captions.srt')]);
  const [videoUrl, captionsUrl] = await Promise.all([putNamedAsset(`${stem}.mp4`, video), putNamedAsset(`${stem}.srt`, srt)]);
  return {
    video: videoUrl, captions: captionsUrl, quality, chapters, summary: metadata?.description?.split(/\n\s*\n/)[0] || '',
    timeline: exportTimeline, duration: totalDuration, youtube: packaged.youtube, thumbnail: packaged.thumbnail, mp3: packaged.mp3,
    transcript: timeline.map(part => part.text), actions: timeline.map(part => part.action),
    scenes: timeline.map((part, index) => ({ text: part.text, title: rawChapters[index + (intro ? 1 : 0)]?.title || '', video: part.sceneAsset, duration: part.duration, captionDuration: part.captionDuration, action: part.action, screenChanged: part.screenChanged, metrics: part.metrics })).filter(scene => scene.video)
  };
}

export async function finishExplainer(id, timeline) {
  'use step';
  const item = await explainer(id);
  enterUsage({ ownerId: item?.ownerId, kind: 'explainer', id: id });
  const browser = new VercelEpisodeSandbox(id, () => {});
  const output = await mixExplainer(browser, id, item, timeline);
  await setExplainerFields(id, { status: 'complete', progress: 'Complete', endedAt: stamp(), ...output });
  await notifyOwner(item.ownerId, `Your explainer is ready: ${item.title}`, 'The narrated video, captions, chapters, and thumbnail are ready to download and publish.');
  await browser.close().catch(() => {});
}

// Voices each saved scene with new text and retimes its clip to the new narration length.
export async function revoiceScenes(browser, item, texts = [], voice = item.voice) {
  const speechProvider = item.speechProvider || 'gateway';
  const speech = speechProviders.get(speechProvider);
  if (!speech) throw new Error('The narration voice provider is unavailable.');
  const timeline = [];
  for (const [index, scene] of item.scenes.entries()) {
    const text = String(texts[index] ?? scene.text);
    const generated = await speech.synthesize(text, supportedVoice(speechProvider, voice, 'coral'), { style: 'clear, friendly product walkthrough narrator' });
    const chunks = [];
    for await (const chunk of Buffer.isBuffer(generated) || generated instanceof Uint8Array ? [generated] : generated) chunks.push(Buffer.from(chunk));
    const audioPath = `/tmp/rerender-${index}.mp3`, sourcePath = `/tmp/rerender-source-${index}.mp4`, videoPath = `/tmp/rerender-${index}.mp4`, paddedPath = `/tmp/rerender-${index}.m4a`;
    await browser.writeSandboxFile(audioPath, Buffer.concat(chunks));
    await browser.writeSandboxFile(sourcePath, await readAssetBytes(scene.video));
    const probe = await browser.run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath]);
    const speechDuration = Math.max(2, Math.min(40, Number((await probe.stdout()).trim()) || 8));
    const ratio = Math.max(0.6, Math.min(1.6, speechDuration / Math.max(0.5, Number(scene.duration) || speechDuration)));
    let result = await browser.run('ffmpeg', ['-y', '-i', sourcePath, '-vf', `setpts=${ratio.toFixed(6)}*PTS,tpad=stop_mode=clone:stop_duration=40,fps=30,format=yuv420p`, '-t', speechDuration.toFixed(3), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', videoPath], 10 * 60 * 1000);
    if (result.exitCode) throw new Error(`Could not retime scene ${index + 1}: ${(await result.stderr()).slice(-800)}`);
    result = await browser.run('ffmpeg', ['-y', '-i', audioPath, '-af', 'apad', '-t', speechDuration.toFixed(3), '-c:a', 'aac', '-b:a', '192k', paddedPath], 5 * 60 * 1000);
    if (result.exitCode) throw new Error(`Could not align narration ${index + 1}: ${(await result.stderr()).slice(-800)}`);
    timeline.push({ ...scene, text, duration: speechDuration, captionDuration: speechDuration, video: videoPath, audio: paddedPath, sceneAsset: scene.video });
  }
  return timeline;
}

// Re-voices and re-captions the saved scene clips: each clip is retimed to its new narration.
export async function rerenderExplainer(id) {
  'use step';
  const item = await explainer(id);
  enterUsage({ ownerId: item?.ownerId, kind: 'explainer', id: id });
  if (!item?.scenes?.length) throw new Error('This explainer has no saved scenes to re-render. Restart it instead.');
  await setExplainerFields(id, { progress: 'Re-voicing narration' });
  const browser = new VercelEpisodeSandbox(`rerender-${id}`, () => {});
  try {
    const timeline = await revoiceScenes(browser, item, item.scenes.map(scene => scene.text));
    const renderVersion = (Number(item.renderVersion) || 0) + 1;
    const output = await mixExplainer(browser, id, { ...item, renderVersion }, timeline);
    await setExplainerFields(id, { status: 'complete', progress: 'Complete', renderVersion, renderedAt: stamp(), rerenderError: null, ...output });
  } finally {
    await browser.close().catch(() => {});
  }
}

// A failed re-render keeps the previous video and refunds the re-render charge.
export async function failExplainerRerender(id, message) {
  'use step';
  await captureError(new Error(message || 'Re-render failed.'), { kind: 'explainer', id, stage: 'rerender' });
  const item = await explainer(id);
  if (item?.rerenderCredits && item.ownerId) await refundCredits(item.ownerId, item.rerenderCredits, 'explainer', item.rerenderReference || `${id}:rerender`);
  await setExplainerFields(id, { status: 'complete', progress: 'Complete', rerenderCredits: 0, rerenderError: String(message || 'Re-render failed.').slice(0, 2000) });
}

// Drafts a scene-by-scene plan the user can edit and approve before any recording is paid for.
export async function draftExplainerPlan(id) {
  'use step';
  const item = await explainer(id);
  enterUsage({ ownerId: item?.ownerId, kind: 'explainer', id: id });
  await setExplainerFields(id, { status: 'planning', progress: 'Drafting the scene plan', error: null });
  const browser = new VercelEpisodeSandbox(id, () => {});
  await browser.setViewport(1920, 1080);
  if (!item.authRequired) await browser.command(['open', item.url]);
  await browser.dismissOverlays();
  const capture = await browser.captureForModel(item.url);
  const budget = sceneBudgetFor(item);
  const provider = modelProviders.get('gateway');
  const messages = [
    { role: 'system', content: `You plan a narrated product walkthrough video before it is recorded. Return JSON {"scenes":[{"title":string,"goal":string,"narration":string}]}. Plan ${Math.max(2, budget - 2)} to ${budget} scenes that cover the requested workflow in order, each achievable with ONE visible, safe, reversible action (click, type a demo value, scroll, or open a page). title: 2-5 words. goal: the one action and what it reveals. narration: 12-28 words spoken while it happens, describing only what will be visible. Never plan deleting, paying, publishing, sending messages, changing account settings, or logging out.` },
    { role: 'user', content: `Application: ${item.url}\nRequested coverage: ${item.brief}\nCurrent page: ${capture.screen.title}\nAccessibility snapshot (truncated):\n${String(capture.screen.content || '').slice(0, 5000)}` }
  ];
  const routing = { user: item.ownerId, tags: ['feature:explainer-plan'] };
  const result = process.env.COMPUTER_USE_SNAPSHOT_ID && provider.generateVisual
    ? await provider.generateVisual(messages, capture.image, modelFor('explainer'), { ...routing, output: 'json' })
    : await provider.generate(messages, modelFor('explainer'), routing);
  const scenes = normalizePlan(result, budget);
  if (!scenes.length) throw new Error('The planner returned no usable scenes. Make the workflow brief more specific.');
  await setExplainerFields(id, { status: 'awaiting_approval', progress: 'Scene plan ready for review', plan: { scenes, approved: false, createdAt: stamp() } });
  return scenes;
}

export function normalizePlan(result, budget = 20) {
  const scenes = Array.isArray(result?.scenes) ? result.scenes : Array.isArray(result) ? result : [];
  return scenes.map(scene => ({
    title: String(scene?.title || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    goal: String(scene?.goal || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    narration: String(scene?.narration || '').replace(/\s+/g, ' ').trim().slice(0, 360)
  })).filter(scene => scene.narration && (scene.goal || scene.title)).slice(0, Math.max(1, Math.min(20, Number(budget) || 20)));
}

export async function failExplainerPlan(id, message) {
  'use step';
  await captureError(new Error(message || 'Planning failed.'), { kind: 'explainer', id, stage: 'plan' });
  await setExplainerFields(id, { status: 'draft', progress: 'Plan could not be drafted', error: String(message || 'Planning failed.').slice(0, 2000) });
}

export async function failExplainer(id, message) {
  'use step';
  await captureError(new Error(message || 'Explainer failed.'), { kind: 'explainer', id, stage: 'recording' });
  const item = await explainer(id);
  if (item?.creditsCharged && item.ownerId) await refundCredits(item.ownerId, item.creditsCharged, 'explainer', id);
  await setExplainerFields(id, { status: 'failed', progress: 'Failed', endedAt: stamp(), error: String(message).slice(0, 2000) });
  await new VercelEpisodeSandbox(id, () => {}).close().catch(() => {});
}

export { mixExplainer };
