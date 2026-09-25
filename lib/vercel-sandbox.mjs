import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { putAsset } from './store.mjs';

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
export const tools = new Set(['code', 'browser', 'diagram', 'file', 'play_audio']);

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
    const snapshotId = process.env.AGENT_BROWSER_SNAPSHOT_ID;
    return Sandbox.getOrCreate({
      name: `podcast-${this.episodeId}`,
      persistent: true,
      timeout: 30 * 60 * 1000,
      ...(snapshotId ? { source: { type: 'snapshot', snapshotId } } : { runtime: 'node24' }),
      onCreate: snapshotId ? undefined : sandbox => installAgentBrowserInVercelSandbox(sandbox)
    });
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
    const sandbox = existingSandbox || await this.ensure();
    const { runAgentBrowserCommand } = await import('@agent-browser/sandbox/vercel');
    const [tree, currentUrl, title] = await Promise.all([
      runAgentBrowserCommand(sandbox, ['snapshot', '-i', '-c'], { session: this.session }),
      runAgentBrowserCommand(sandbox, ['get', 'url'], { session: this.session }),
      runAgentBrowserCommand(sandbox, ['get', 'title'], { session: this.session })
    ]);
    await runAgentBrowserCommand(sandbox, ['screenshot', '/tmp/podcast-browser.png'], { session: this.session });
    const screenshot = await sandbox.readFileToBuffer({ path: '/tmp/podcast-browser.png' });
    const image = screenshot ? await putAsset('browser.png', screenshot) : null;
    const pageUrl = agentValue(currentUrl, 'url').trim() || fallbackUrl;
    return { type: 'browser', title: pageUrl, content: `${agentValue(title, 'title').trim()}\n${agentValue(tree, 'snapshot')}`.slice(0, 10000), image };
  }
  async command(args) {
    const sandbox = await this.ensure();
    const { runAgentBrowserCommand } = await import('@agent-browser/sandbox/vercel');
    return runAgentBrowserCommand(sandbox, args.map(value => String(value)), { session: this.session });
  }
  async setViewport(width = 1920, height = 1080) {
    await this.command(['set', 'viewport', String(width), String(height)]);
  }
  async startVideo(filename) {
    await this.command(['record', 'start', filename, '--cursor']);
  }
  async stopVideo() {
    await this.command(['record', 'stop']);
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
      if (!/^https?:\/\//i.test(action.url || '')) throw new Error('The requested page URL is invalid.');
      await this.command(['open', action.url]);
    } else if (type === 'click') await this.command(['click', action.selector]);
    else if (type === 'fill') await this.command(['fill', action.selector, String(action.value || '')]);
    else if (type === 'type') await this.command(['type', action.selector, String(action.value || '')]);
    else if (type === 'select') await this.command(['select', action.selector, String(action.value || '')]);
    else if (type === 'press') { await this.command(['click', action.selector]); await this.command(['press', String(action.key || 'ArrowRight')]); }
    else if (type === 'scroll') await this.command(['scroll', action.direction === 'up' ? 'up' : 'down', String(Math.max(200, Math.min(1200, Number(action.amount) || 650)))]);
    else await this.command(['wait', String(Math.max(300, Math.min(3000, Number(action.ms) || 800)))]);
  }
  async locateLoginPage(demo) {
    const startUrl = String(demo?.loginUrl || demo?.url || '');
    if (!/^https?:\/\//i.test(startUrl)) throw new Error('A valid application or login URL is required.');
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
