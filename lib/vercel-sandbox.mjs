import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { putAsset } from './store.mjs';
import { assertPublicHttpUrl } from './url-security.mjs';

const clipped = value => String(value ?? '').slice(0, 10000);
const xml = value => clipped(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const agentValue = (result, key) => {
  const raw = String(result?.stdout ?? '');
  try {
    const data = JSON.parse(raw)?.data;
    if (key && data && typeof data === 'object' && key in data) return String(data[key] ?? '');
    if (typeof data === 'string') return data;
  } catch {}
  return raw;
};
export const isSandboxNameConflict = error => {
  const message = String(error?.message || error);
  const isBadRequest = Number(error?.statusCode || error?.status) === 400 || /status code 400\b/i.test(message);
  return isBadRequest && /sandbox.+name.+already exists|already exists.+project/i.test(message);
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const tools = new Set(['code', 'browser', 'diagram', 'file', 'play_audio']);
const DESKTOP_PORT = 6080;
const CDP_PORT = 9222;
const DISPLAY_ENV = { DISPLAY: ':99' };

export class VercelEpisodeSandbox {
  constructor(episodeId, emit, screen = { type: 'idle', title: 'Sandbox ready', content: '' }, role = 'system') {
    this.episodeId = episodeId;
    this.emit = emit;
    this.screen = screen;
    this.role = role;
    this.session = `podcast-${String(episodeId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60)}`;
  }
  async ensure() {
    const { Sandbox } = await import('@vercel/sandbox');
    const { installAgentBrowserInVercelSandbox } = await import('@agent-browser/sandbox/vercel');
    const snapshotId = process.env.COMPUTER_USE_SNAPSHOT_ID || process.env.AGENT_BROWSER_SNAPSHOT_ID;
    const name = `podcast-${this.episodeId}`;
    const options = {
      name,
      persistent: true,
      timeout: 30 * 60 * 1000,
      ...(process.env.COMPUTER_USE_SNAPSHOT_ID ? { ports: [DESKTOP_PORT] } : {}),
      ...(snapshotId ? { source: { type: 'snapshot', snapshotId } } : { runtime: 'node24' }),
      onCreate: snapshotId ? undefined : sandbox => installAgentBrowserInVercelSandbox(sandbox)
    };
    try {
      return await Sandbox.getOrCreate(options);
    } catch (error) {
      if (!isSandboxNameConflict(error)) throw error;
      let resumeError = error;
      for (let attempt = 0; attempt < 7; attempt++) {
        await delay(150 * (attempt + 1));
        try { return await Sandbox.get({ name, resume: true }); }
        catch (cause) { resumeError = cause; }
      }
      throw new Error(`The existing sandbox '${name}' could not be resumed after its creation conflict: ${resumeError.message || resumeError}`, { cause: resumeError });
    }
  }
  computerUseEnabled() { return Boolean(process.env.COMPUTER_USE_SNAPSHOT_ID); }
  async rawAgentCommand(sandbox, args) {
    const { runAgentBrowserCommand } = await import('@agent-browser/sandbox/vercel');
    return runAgentBrowserCommand(sandbox, args.map(value => String(value)), { session: this.session });
  }
  async ensureDesktop(existingSandbox = null) {
    const sandbox = existingSandbox || await this.ensure();
    if (!this.computerUseEnabled()) return sandbox;
    const marker = `/tmp/.sales-forge-desktop-${this.session}`;
    const check = await sandbox.runCommand('sh', ['-lc', `test -f ${marker} && curl -fsS http://127.0.0.1:${CDP_PORT}/json/version >/dev/null`]);
    if (check.exitCode !== 0) {
      const started = await sandbox.runCommand('sh', ['/usr/local/bin/start-sales-forge-desktop.sh', this.session], { timeoutMs: 120000 });
      if (started.exitCode !== 0) throw new Error(`Could not start the Computer Use desktop: ${(await started.stderr()).slice(-1200)}`);
      let ready = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const probe = await sandbox.runCommand('curl', ['-fsS', `http://127.0.0.1:${CDP_PORT}/json/version`]);
        if (probe.exitCode === 0) { ready = true; break; }
        await delay(250);
      }
      if (!ready) throw new Error('The Computer Use desktop started, but Chrome did not expose its control port.');
      await sandbox.runCommand('touch', [marker]);
    }
    const connectedMarker = `${marker}-connected`;
    const connected = await sandbox.runCommand('test', ['-f', connectedMarker]);
    if (connected.exitCode !== 0) {
      await this.rawAgentCommand(sandbox, ['connect', `http://127.0.0.1:${CDP_PORT}`]);
      await sandbox.runCommand('touch', [connectedMarker]);
    }
    return sandbox;
  }
  async desktopStreamUrl(interactive = false) {
    const sandbox = await this.ensureDesktop();
    if (!this.computerUseEnabled()) return '';
    const viewOnly = interactive ? '' : '&view_only=true';
    return `${sandbox.domain(DESKTOP_PORT)}/vnc.html?autoconnect=true&resize=scale&reconnect=true${viewOnly}`;
  }
  async interactiveDesktop(url = '') {
    await this.ensureDesktop();
    const current = agentValue(await this.command(['get', 'url']), 'url').trim();
    if ((!current || current === 'about:blank') && url) await this.performComputerAction({ type: 'visit', url });
    return this.desktopStreamUrl(true);
  }
  async act(name, input = {}) {
    if (!tools.has(name)) throw new Error(`Unknown tool: ${name}`);
    await this.emit('tool_start', { role: this.role, tool: name, input });
    try {
      const screen = await this[name](input);
      this.screen = screen;
      await this.emit('tool_end', { role: this.role, tool: name, screen });
      return screen;
    } catch (cause) {
      this.screen = { type: 'error', title: `${name} failed`, content: cause.message };
      await this.emit('tool_end', { role: this.role, tool: name, screen: this.screen });
      return this.screen;
    }
  }
  async code(input) {
    const sandbox = await this.ensure();
    const language = input.language === 'javascript' ? 'javascript' : 'python';
    const cmd = language === 'javascript' ? 'node' : 'python3';
    const result = await sandbox.runCommand(cmd, language === 'javascript' ? ['-e', clipped(input.code)] : ['-u', '-c', clipped(input.code)], { timeoutMs: 90000 });
    const content = `${await result.stdout()}${await result.stderr()}`.slice(-30000) || '(no output)';
    await this.emit('tool_output', { tool: 'code', stream: 'stdout', chunk: content, screen: { type: 'terminal', title: `${language} execution`, content } });
    return { type: 'terminal', title: `${language} · exit ${result.exitCode}`, content };
  }
  async file(input) {
    const sandbox = await this.ensure();
    const name = String(input.name || 'artifact.txt').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const content = String(input.content ?? '').slice(0, 250000);
    await sandbox.writeFiles([{ path: `/tmp/${name}`, content: Buffer.from(content) }]);
    const asset = await putAsset(name, content);
    return { type: 'file', title: name, content: content.slice(0, 5000), asset };
  }
  async play_audio(input) {
    const filename = String(input.path || '');
    if (!/^\/(tmp|home)\/[^\0]+\.(mp3|wav|ogg)$/i.test(filename)) throw new Error('Use an MP3, WAV, or OGG file under /tmp or /home.');
    const data = await (await this.ensure()).readFileToBuffer({ path: filename });
    if (!data || data.length > 50_000_000) throw new Error('Sandbox audio is missing or exceeds 50 MB.');
    const audio = await putAsset(path.basename(filename), data);
    return { type: 'audio', title: path.basename(filename), content: `Playing ${path.basename(filename)} from the episode sandbox.`, audio, asset: audio };
  }
  async diagram(input) {
    const nodes = (Array.isArray(input.nodes) ? input.nodes : []).slice(0, 16).map((node, index) => ({ id: String(node.id || index), label: clipped(node.label).slice(0, 60) }));
    const edges = (Array.isArray(input.edges) ? input.edges : []).slice(0, 24);
    const positions = new Map(nodes.map((node, index) => [node.id, { x: 150 + (index % 4) * 245, y: 155 + Math.floor(index / 4) * 145 }]));
    const height = Math.max(280, 95 + Math.ceil(nodes.length / 4) * 160);
    const lines = edges.map(edge => { const a = positions.get(String(edge.from)), b = positions.get(String(edge.to)); return a && b ? `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#76ddd1" stroke-width="3" marker-end="url(#arrow)"/>` : ''; }).join('');
    const boxes = nodes.map(node => { const p = positions.get(node.id); return `<g><rect x="${p.x - 100}" y="${p.y - 48}" width="200" height="96" rx="17" fill="#213844" stroke="#76ddd1" stroke-width="2"/><text x="${p.x}" y="${p.y + 8}" text-anchor="middle" font-family="Arial" font-size="25" fill="white">${xml(node.label)}</text></g>`; }).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 ${height}"><rect width="1080" height="${height}" fill="#10212b"/><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto"><path d="M0 0 L0 6 L9 3 z" fill="#76ddd1"/></marker></defs><text x="55" y="48" font-family="Arial" font-size="30" fill="#fff">${xml(input.title || 'Live diagram')}</text>${lines}${boxes}</svg>`;
    const image = await putAsset('diagram.svg', svg);
    return { type: 'diagram', title: clipped(input.title || 'Live diagram'), content: nodes.map(node => node.label).join(' · '), image };
  }
  async browser(input) {
    if (this.computerUseEnabled()) {
      const action = String(input.action || input.type || 'visit');
      const normalized = { ...input, type: action === 'fill' ? 'type' : action };
      const clipId = randomUUID();
      const rawClip = `/tmp/browser-action-${clipId}.mkv`;
      const mp4Clip = `/tmp/browser-action-${clipId}.mp4`;
      await this.startVideo(rawClip);
      try { await this.performComputerAction(normalized); }
      finally { await this.stopVideo().catch(() => {}); }
      const encoded = await this.run('ffmpeg', ['-y', '-i', rawClip, '-an', '-c:v', 'copy', '-movflags', '+faststart', mp4Clip], 5 * 60 * 1000);
      if (encoded.exitCode !== 0) throw new Error(`Could not prepare the Computer Use action clip: ${(await encoded.stderr()).slice(-1000)}`);
      const [screen, video] = await Promise.all([this.capture(null, input.url || ''), this.readSandboxFile(mp4Clip)]);
      return { ...screen, video: await putAsset('browser-action.mp4', video) };
    }
    const sandbox = await this.ensure();
    const { runAgentBrowserCommand } = await import('@agent-browser/sandbox/vercel');
    const action = ['visit', 'click', 'fill'].includes(input.action) ? input.action : 'visit';
    const url = String(input.url || '');
    if (action === 'visit' && !/^https?:\/\//i.test(url)) throw new Error('Browser URLs must begin with http:// or https://.');
    const args = action === 'visit' ? ['open', url] : action === 'click' ? ['click', clipped(input.selector)] : ['fill', clipped(input.selector), clipped(input.value)];
    await runAgentBrowserCommand(sandbox, args, { session: this.session });
    return this.capture(sandbox, url);
  }
  async capture(existingSandbox = null, fallbackUrl = '') {
    const sandbox = await this.ensureDesktop(existingSandbox || await this.ensure());
    const [tree, currentUrl, title] = await Promise.all([
      this.rawAgentCommand(sandbox, ['snapshot', '-i', '-c']),
      this.rawAgentCommand(sandbox, ['get', 'url']),
      this.rawAgentCommand(sandbox, ['get', 'title'])
    ]);
    if (this.computerUseEnabled()) {
      const shot = await sandbox.runCommand({ cmd: 'import', args: ['-window', 'root', '/tmp/podcast-browser.png'], env: DISPLAY_ENV });
      if (shot.exitCode !== 0) throw new Error(`Desktop screenshot failed: ${(await shot.stderr()).slice(-800)}`);
    } else await this.rawAgentCommand(sandbox, ['screenshot', '/tmp/podcast-browser.png']);
    const screenshot = await sandbox.readFileToBuffer({ path: '/tmp/podcast-browser.png' });
    const image = screenshot ? await putAsset('browser.png', screenshot) : null;
    const pageUrl = agentValue(currentUrl, 'url').trim() || fallbackUrl;
    return { type: 'browser', title: pageUrl, content: `${agentValue(title, 'title').trim()}\n${agentValue(tree, 'snapshot')}`.slice(0, 10000), image, visualHash: screenshot ? createHash('sha256').update(screenshot).digest('hex') : '', liveUrl: this.computerUseEnabled() ? await this.desktopStreamUrl() : '' };
  }
  async captureForModel(fallbackUrl = '') {
    const screen = await this.capture(null, fallbackUrl);
    const image = await this.readSandboxFile('/tmp/podcast-browser.png');
    if (!image?.length) throw new Error('The Computer Use screenshot is empty.');
    return { screen, image };
  }
  async command(args) {
    const sandbox = await this.ensureDesktop();
    return this.rawAgentCommand(sandbox, args);
  }
  async humanCommand(args) {
    const sandbox = await this.ensure();
    const { runAgentBrowserCommand } = await import('@agent-browser/sandbox/vercel');
    return runAgentBrowserCommand(sandbox, ['--input-mode', 'human', ...args.map(value => String(value))], { session: this.session });
  }
  async setViewport(width = 1920, height = 1080) {
    await this.command(['set', 'viewport', String(width), String(height)]);
  }
  async startVideo(filename) {
    if (!this.computerUseEnabled()) return this.command(['record', 'start', filename, '--cursor']);
    const sandbox = await this.ensureDesktop();
    const result = await sandbox.runCommand({ cmd: 'sh', args: ['-lc', `if test -f /tmp/computer-recording.pid && kill -0 $(cat /tmp/computer-recording.pid) 2>/dev/null; then echo 'desktop recorder is already running' >&2; exit 1; fi; nohup ffmpeg -y -f x11grab -draw_mouse 1 -video_size 1920x1080 -framerate 30 -i :99 -an -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -f matroska ${filename} >/tmp/computer-recording.log 2>&1 & echo $! >/tmp/computer-recording.pid`], env: DISPLAY_ENV });
    if (result.exitCode !== 0) throw new Error(`Could not start desktop recording: ${(await result.stderr()).slice(-800)}`);
    await delay(400);
  }
  async stopVideo() {
    if (!this.computerUseEnabled()) return this.command(['record', 'stop']);
    const sandbox = await this.ensureDesktop();
    const result = await sandbox.runCommand('sh', ['-lc', 'if test -f /tmp/computer-recording.pid; then kill -INT $(cat /tmp/computer-recording.pid) 2>/dev/null || true; for i in $(seq 1 40); do kill -0 $(cat /tmp/computer-recording.pid) 2>/dev/null || break; sleep .1; done; rm -f /tmp/computer-recording.pid; fi']);
    if (result.exitCode !== 0) throw new Error(`Could not stop desktop recording: ${(await result.stderr()).slice(-800)}`);
  }
  async writeSandboxFile(filename, data) {
    await (await this.ensure()).writeFiles([{ path: filename, content: Buffer.from(data) }]);
  }
  async readSandboxFile(filename) {
    return (await this.ensure()).readFileToBuffer({ path: filename });
  }
  async run(program, args = [], timeoutMs = 120000) {
    return (await this.ensure()).runCommand(program, args.map(value => String(value)), { timeoutMs });
  }
  async performBrowserAction(action = {}) {
    const type = String(action.type || 'wait');
    if (type === 'visit') {
      await assertPublicHttpUrl(action.url);
      await this.command(['open', action.url]);
      await this.command(['wait', '900']);
    } else if (['click','fill','type','select','press'].includes(type)) {
      const selector = String(action.selector || '');
      if (!selector) throw new Error(`${type} requires a visible element reference.`);
      await this.command(['scrollintoview', selector]);
      await this.command(['wait', '250']);
      await this.humanCommand(['hover', selector]);
      await this.command(['wait', '400']);
      if (type === 'click') await this.humanCommand(['click', selector]);
      else if (type === 'select') {
        await this.humanCommand(['click', selector]);
        await this.command(['wait', '350']);
        await this.humanCommand(['select', selector, String(action.value || '')]);
      } else if (type === 'press') {
        await this.humanCommand(['click', selector]);
        await this.command(['wait', '250']);
        await this.humanCommand(['press', String(action.key || 'ArrowRight')]);
      } else {
        await this.humanCommand(['click', selector]);
        await this.command(['wait', '300']);
        if (type === 'fill') {
          await this.humanCommand(['press', 'Control+a']);
          await this.humanCommand(['press', 'Backspace']);
        }
        await this.humanCommand(['keyboard', 'type', String(action.value || '')]);
      }
      await this.command(['wait', '700']);
    } else if (type === 'scroll') {
      const direction = action.direction === 'up' ? -1 : 1;
      const amount = Math.max(200, Math.min(1200, Number(action.amount) || 650));
      const steps = Math.max(3, Math.ceil(amount / 180));
      for (let index = 0; index < steps; index++) {
        await this.humanCommand(['mouse', 'wheel', String(Math.round(direction * amount / steps)), '0']);
        await this.command(['wait', '120']);
      }
      await this.command(['wait', '500']);
    }
    else await this.command(['wait', String(Math.max(300, Math.min(3000, Number(action.ms) || 800)))]);
  }
  async performComputerAction(action = {}) {
    if (!this.computerUseEnabled()) return this.performBrowserAction(action);
    const sandbox = await this.ensureDesktop();
    const type = String(action.type || 'wait');
    const bounded = (value, max) => Math.max(0, Math.min(max, Math.round(Number(value) || 0)));
    let x = bounded(action.x, 1919), y = bounded(action.y, 1079);
    const selector = /^@[a-zA-Z0-9_-]+$/.test(String(action.selector || '')) ? String(action.selector) : '';
    if (selector && ['click','double_click','right_click','type','drag'].includes(type)) {
      await this.command(['scrollintoview', selector]);
      const [boxResult, metricsResult] = await Promise.all([
        this.command(['get', 'box', selector]),
        this.command(['eval', '({screenX,screenY,chromeX:outerWidth-innerWidth,chromeY:outerHeight-innerHeight})'])
      ]);
      const box = boxResult.json?.data || {};
      const metrics = metricsResult.json?.data?.result || {};
      if ([box.x, box.y, box.width, box.height, metrics.screenX, metrics.screenY, metrics.chromeX, metrics.chromeY].every(value => Number.isFinite(Number(value)))) {
        x = bounded(Number(metrics.screenX) + Number(metrics.chromeX) / 2 + Number(box.x) + Number(box.width) / 2, 1919);
        y = bounded(Number(metrics.screenY) + Number(metrics.chromeY) + Number(box.y) + Number(box.height) / 2, 1079);
      }
    }
    const runPython = async (source, args = []) => {
      const result = await sandbox.runCommand({ cmd: 'python3', args: ['-c', source, ...args.map(String)], env: DISPLAY_ENV, timeoutMs: 90000 });
      if (result.exitCode !== 0) throw new Error(`Computer Use ${type} failed: ${(await result.stderr()).slice(-1000)}`);
    };
    const move = async () => runPython("import math,random,subprocess,sys,time\nx,y=map(int,sys.argv[1:3]); p=subprocess.run(['xdotool','getmouselocation','--shell'],capture_output=True,text=True).stdout; d=dict(v.split('=',1) for v in p.splitlines() if '=' in v); sx,sy=int(d.get('X',0)),int(d.get('Y',0)); steps=max(8,min(35,int(math.hypot(x-sx,y-sy)/35))); bend=random.uniform(-.16,.16);\nfor i in range(1,steps+1):\n t=i/steps; e=3*t*t-2*t*t*t; px=sx+(x-sx)*e+math.sin(math.pi*t)*(y-sy)*bend; py=sy+(y-sy)*e-math.sin(math.pi*t)*(x-sx)*bend; subprocess.run(['xdotool','mousemove','--sync',str(round(px)),str(round(py))]); time.sleep(random.uniform(.012,.032))", [x, y]);
    if (type === 'visit') {
      await assertPublicHttpUrl(action.url);
      await this.command(['open', action.url]);
      await this.command(['wait', '900']);
    } else if (['click','double_click','right_click','type'].includes(type)) {
      await move();
      await delay(180 + Math.floor(Math.random() * 260));
      const button = type === 'right_click' ? '3' : '1';
      const clicks = type === 'double_click' ? ['click', '--repeat', '2', '--delay', '110', button] : ['click', button];
      await runPython("import subprocess,sys\nsubprocess.run(['xdotool',*sys.argv[1:]],check=True)", clicks);
      if (type === 'type') {
        const text = String(action.text ?? action.value ?? '').slice(0, 1000);
        await delay(220);
        await runPython("import random,subprocess,sys,time\nfor ch in sys.argv[1]:\n subprocess.run(['xdotool','type','--clearmodifiers','--delay',str(random.randint(28,95)),ch]); time.sleep(random.uniform(.005,.035))", [text]);
      }
      await delay(550);
    } else if (type === 'key') {
      const key = String(action.key || 'Return').replace(/[^A-Za-z0-9+_-]/g, '').slice(0, 40);
      await runPython("import subprocess,sys\nsubprocess.run(['xdotool','key',sys.argv[1]],check=True)", [key]);
      await delay(350);
    } else if (type === 'scroll') {
      const direction = action.direction === 'up' ? '4' : '5';
      const steps = Math.max(2, Math.min(9, Math.round(Number(action.amount) || 5)));
      await runPython("import random,subprocess,sys,time\nfor _ in range(int(sys.argv[2])):\n subprocess.run(['xdotool','click',sys.argv[1]]); time.sleep(random.uniform(.09,.18))", [direction, steps]);
      await delay(450);
    } else if (type === 'drag') {
      const endX = bounded(action.endX, 1919), endY = bounded(action.endY, 1079);
      await move();
      await runPython("import subprocess,sys,time\nsubprocess.run(['xdotool','mousedown','1'],check=True); time.sleep(.18); subprocess.run(['xdotool','mousemove','--sync',sys.argv[1],sys.argv[2]],check=True); time.sleep(.12); subprocess.run(['xdotool','mouseup','1'],check=True)", [endX, endY]);
    } else await delay(Math.max(300, Math.min(3000, Number(action.ms) || 800)));
  }
  async locateLoginPage(demo) {
    const startUrl = String(demo?.loginUrl || demo?.url || '');
    await assertPublicHttpUrl(startUrl);
    await this.command(['open', startUrl]);
    await this.command(['wait', '900']);
    if (!demo?.loginUrl) {
      const selector = JSON.stringify(String(demo?.usernameSelector || 'input[type="email"], input[autocomplete="username"], input[autocomplete="email"], input[name*="email" i], input[name*="user" i], input[id*="email" i], input[id*="user" i]'));
      const passwordSelector = JSON.stringify(String(demo?.passwordSelector || 'input[type="password"], input[autocomplete="current-password"]'));
      const discovery = `(()=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};try{const user=document.querySelector(${selector}),password=document.querySelector(${passwordSelector});if(user&&(password||/\\/(?:login|log-in|sign-in|signin)(?:[/?#]|$)/i.test(location.pathname)))return'form-ready'}catch{}const controls=[...document.querySelectorAll('a,button,[role="button"]')].filter(visible);const score=e=>{const text=(e.innerText||e.textContent||'').trim().toLowerCase();const href=(e.getAttribute('href')||'').toLowerCase();if(/^(sign in|log in|login|member login|account login)$/.test(text))return 4;if(/sign.?in|log.?in|login/.test(href))return 3;if(/sign in|log in|login/.test(text))return 2;return 0};const target=controls.map(e=>({e,n:score(e)})).sort((a,b)=>b.n-a.n)[0];if(!target?.n)return'not-found';target.e.click();return'clicked'})()`;
      await this.command(['eval', discovery]).catch(() => {});
      await this.command(['wait', '1200']);
    }
    const current = await this.command(['get', 'url']);
    return agentValue(current, 'url').trim() || startUrl;
  }
  async login(demo, credentials) {
    if (!demo?.url || !/^https?:\/\//i.test(demo.url)) throw new Error('A valid demo URL is required for login.');
    if (!credentials?.username || !credentials?.password) throw new Error('Login credentials are required for this demo.');
    const sandbox = await this.ensure();
    const { runAgentBrowserCommand } = await import('@agent-browser/sandbox/vercel');
    const secretPath = `/tmp/podcast-login-${randomUUID()}.json`;
    const scriptPath = '/tmp/podcast-auth.mjs';
    const profile = `episode-${String(this.episodeId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60)}`;
    const authUrl = await this.locateLoginPage(demo);
    const script = `import fs from 'node:fs';import{spawnSync}from'node:child_process';const d=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const a=['--session',d.session,'auth','save',d.profile,'--url',d.authUrl,'--username',d.username,'--password-stdin','--username-selector',d.usernameSelector,'--password-selector',d.passwordSelector,'--submit-selector',d.submitSelector];const r=spawnSync('agent-browser',a,{input:d.password,encoding:'utf8'});if(r.status!==0){process.stderr.write(r.stderr||'Authentication setup failed');process.exit(r.status||1)}`;
    const legacyUsername = 'input[type="email"], input[name="email"], input[name="username"]';
    const legacyPassword = 'input[type="password"]';
    const legacySubmit = 'button[type="submit"], input[type="submit"]';
    const secret = {
      session: this.session, profile, ...demo, authUrl, username: credentials.username, password: credentials.password,
      usernameSelector: !demo.usernameSelector || demo.usernameSelector === legacyUsername ? 'input[type="email"], input[autocomplete="username"], input[autocomplete="email"], input[name*="email" i], input[name*="user" i], input[id*="email" i], input[id*="user" i]' : demo.usernameSelector,
      passwordSelector: !demo.passwordSelector || demo.passwordSelector === legacyPassword ? 'input[type="password"], input[autocomplete="current-password"]' : demo.passwordSelector,
      submitSelector: !demo.submitSelector || demo.submitSelector === legacySubmit ? 'button[type="submit"], input[type="submit"], button[name*="login" i], button[name*="sign" i]' : demo.submitSelector
    };
    await sandbox.writeFiles([{ path: scriptPath, content: Buffer.from(script) }, { path: secretPath, content: Buffer.from(JSON.stringify(secret)) }]);
    try {
      const saved = await sandbox.runCommand('node', [scriptPath, secretPath]);
      if (saved.exitCode !== 0) {
        const detail = (await saved.stderr()).slice(-1800);
        if (/Timed out waiting for (username|password) selector/i.test(detail)) {
          throw new Error(`The login fields were not found at ${authUrl}. Enter the exact login page URL and, if needed, its custom field selectors.`);
        }
        throw new Error(detail || 'Authentication setup failed.');
      }
      await runAgentBrowserCommand(sandbox, ['auth', 'login', profile], { session: this.session });
    } finally {
      await sandbox.runCommand('rm', ['-f', secretPath]);
      await runAgentBrowserCommand(sandbox, ['auth', 'delete', profile], { session: this.session }).catch(() => {});
    }
    return this.capture(sandbox, demo.url);
  }
  async close() {
    const { Sandbox } = await import('@vercel/sandbox');
    try { await (await Sandbox.get({ name: `podcast-${this.episodeId}` })).stop(); } catch {}
  }
}
