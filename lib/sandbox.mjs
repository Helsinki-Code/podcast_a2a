import { putAsset } from './store.mjs';
import path from 'node:path';

export const tools = new Map();
export const registerTool = (name, handler) => tools.set(name, handler);
const safe = value => String(value ?? '').slice(0, 10000);
const xml = value => safe(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class EpisodeSandbox {
  constructor(emit) { this.emit = emit; this.instance = null; this.browserReady = false; this.screen = { type: 'idle', title: 'Sandbox ready', content: '' }; }
  async ensure() {
    if (this.instance) return this.instance;
    if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required for code, browser, and file tools.');
    const { Sandbox } = await import('e2b');
    const opts = { timeoutMs: 30 * 60 * 1000 };
    this.instance = process.env.E2B_TEMPLATE ? await Sandbox.create(process.env.E2B_TEMPLATE, opts) : await Sandbox.create(opts);
    return this.instance;
  }
  async act(name, input = {}) {
    const handler = tools.get(name);
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    this.emit('tool_start', { tool: name, input });
    try {
      const screen = await handler(this, input);
      this.screen = screen;
      this.emit('tool_end', { tool: name, screen });
      return screen;
    } catch (error) {
      this.screen = { type: 'error', title: `${name} failed`, content: error.message };
      this.emit('tool_end', { tool: name, screen: this.screen });
      return this.screen;
    }
  }
  async close() { if (this.instance) await this.instance.kill().catch(() => {}); }
}

registerTool('code', async (session, input) => {
  const sandbox = await session.ensure();
  const code = safe(input.code);
  const lang = input.language === 'javascript' ? 'javascript' : 'python';
  const command = lang === 'javascript' ? `node -e ${shellQuote(code)}` : `python3 -u -c ${shellQuote(code)}`;
  let content = '';
  const push = (stream, value) => {
    const chunk = String(value).slice(0, 4000);
    content = (content + chunk).slice(-30000);
    session.screen = { type: 'terminal', title: `${lang} execution`, content };
    session.emit('tool_output', { tool: 'code', stream, chunk, screen: session.screen });
  };
  const result = await sandbox.commands.run(command, { timeoutMs: 90000, onStdout: x => push('stdout', x), onStderr: x => push('stderr', x) });
  return { type: 'terminal', title: `${lang} · exit ${result.exitCode}`, content: content || result.stdout || result.stderr || '(no output)' };
});

registerTool('browser', async (session, input) => {
  const sandbox = await session.ensure();
  const url = String(input.url || '');
  const action = ['visit', 'click', 'fill'].includes(input.action) ? input.action : 'visit';
  if (action === 'visit' && !/^https?:\/\//i.test(url)) throw new Error('Browser URLs must begin with http:// or https://.');
  session.screen = { type: 'browser', title: url, content: 'Loading page…' };
  session.emit('tool_output', { tool: 'browser', stream: 'status', chunk: `Opening ${url}`, screen: session.screen });
  if (!session.browserReady) {
    try { await sandbox.commands.run('python3 -c "import playwright"', { timeoutMs: 10000 }); }
    catch {
    session.screen = { type: 'browser', title: url, content: 'Installing browser…' };
    session.emit('tool_output', { tool: 'browser', stream: 'status', chunk: 'Installing browser in the episode sandbox…', screen: session.screen });
    await sandbox.commands.run('python3 -m pip install --quiet playwright && python3 -m playwright install chromium', { timeoutMs: 180000, onStdout: x => session.emit('tool_output', { tool: 'browser', stream: 'stdout', chunk: String(x).slice(0, 1000) }) });
    }
    await sandbox.files.write('/tmp/podcast-browser-server.py', browserServer);
    await sandbox.commands.run('python3 -u /tmp/podcast-browser-server.py', { background: true });
    let ready = false;
    for (let i = 0; i < 25; i++) {
      try { await sandbox.commands.run('curl -fsS http://127.0.0.1:8765/health', { timeoutMs: 5000 }); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 400)); }
    }
    if (!ready) throw new Error('Browser service could not start inside the episode sandbox.');
    session.browserReady = true;
  }
  const payload = { action, url, selector: safe(input.selector), value: safe(input.value) };
  const result = await sandbox.commands.run(`curl -fsS -X POST -H 'Content-Type: application/json' --data-binary ${shellQuote(JSON.stringify(payload))} http://127.0.0.1:8765/action`, { timeoutMs: 65000 });
  const page = JSON.parse(result.stdout);
  if (page.error) throw new Error(page.error);
  const imageResponse = await fetch(await sandbox.downloadUrl('/tmp/podcast-browser.png'));
  const image = await putAsset('browser.png', Buffer.from(await imageResponse.arrayBuffer()));
  return { type: 'browser', title: page.url, content: `${page.title}\n${page.text}`.slice(0, 5000), image };
});

const browserServer = `import json\nfrom http.server import BaseHTTPRequestHandler, HTTPServer\nfrom playwright.sync_api import sync_playwright\np=sync_playwright().start()\nbrowser=p.chromium.launch(headless=True)\npage=browser.new_page(viewport={"width":1280,"height":720})\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200);self.end_headers();self.wfile.write(b'ok')\n def do_POST(self):\n  try:\n   data=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))\n   action=data.get('action','visit')\n   if action=='visit': page.goto(data['url'],wait_until='domcontentloaded',timeout=30000)\n   elif action=='click': page.locator(data['selector']).first.click(timeout=10000)\n   elif action=='fill': page.locator(data['selector']).first.fill(data.get('value',''),timeout=10000)\n   else: raise ValueError('Unknown browser action')\n   page.screenshot(path='/tmp/podcast-browser.png',full_page=False)\n   result={'title':page.title(),'url':page.url,'text':page.locator('body').inner_text(timeout=5000)[:4500]}\n  except Exception as e: result={'error':str(e)[:1800]}\n  body=json.dumps(result).encode()\n  self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)\n def log_message(self,*args): pass\nHTTPServer(('127.0.0.1',8765),Handler).serve_forever()\n`;

registerTool('diagram', async (_session, input) => {
  const nodes = (Array.isArray(input.nodes) ? input.nodes : []).slice(0, 16).map((node, i) => ({ id: String(node.id || i), label: safe(node.label).slice(0, 60) }));
  const edges = (Array.isArray(input.edges) ? input.edges : []).slice(0, 24);
  const positions = new Map(nodes.map((node, i) => [node.id, { x: 150 + (i % 4) * 245, y: 155 + Math.floor(i / 4) * 145 }]));
  const viewHeight = Math.max(280, 95 + Math.ceil(nodes.length / 4) * 160);
  const lines = edges.map(edge => { const a = positions.get(String(edge.from)), b = positions.get(String(edge.to)); return a && b ? `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#76ddd1" stroke-width="3" marker-end="url(#arrow)"/>` : ''; }).join('');
  const boxes = nodes.map(node => { const p = positions.get(node.id); return `<g><rect x="${p.x - 100}" y="${p.y - 48}" width="200" height="96" rx="17" fill="#213844" stroke="#76ddd1" stroke-width="2"/><text x="${p.x}" y="${p.y + 8}" text-anchor="middle" font-family="Arial" font-size="25" fill="white">${xml(node.label)}</text></g>`; }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 ${viewHeight}"><rect width="1080" height="${viewHeight}" fill="#10212b"/><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto"><path d="M0 0 L0 6 L9 3 z" fill="#76ddd1"/></marker></defs><text x="55" y="48" font-family="Arial" font-size="30" fill="#fff">${xml(input.title || 'Live diagram')}</text>${lines}${boxes}</svg>`;
  const image = await putAsset('diagram.svg', svg);
  return { type: 'diagram', title: safe(input.title || 'Live diagram'), content: nodes.map(n => n.label).join(' · '), image };
});

registerTool('file', async (session, input) => {
  const sandbox = await session.ensure();
  const filename = String(input.name || 'artifact.txt').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const content = String(input.content ?? '').slice(0, 250000);
  const path = `/tmp/${filename}`;
  await sandbox.files.write(path, content);
  const asset = await putAsset(filename, content);
  return { type: 'file', title: filename, content: content.slice(0, 5000), asset };
});

registerTool('play_audio', async (session, input) => {
  const sandbox = await session.ensure();
  const filename = String(input.path || '');
  if (!/^\/(tmp|home)\/[^\0]+\.(mp3|wav|ogg)$/i.test(filename)) throw new Error('Use an MP3, WAV, or OGG file under /tmp or /home in this episode sandbox.');
  const response = await fetch(await sandbox.downloadUrl(filename));
  if (!response.ok) throw new Error(`Could not read sandbox audio: ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > 50_000_000) throw new Error('Sandbox audio exceeds 50 MB.');
  const audio = await putAsset(path.basename(filename), data);
  return { type: 'audio', title: path.basename(filename), content: `Playing ${path.basename(filename)} from the episode sandbox.`, audio, asset: audio };
});

function shellQuote(value) { return `'${value.replace(/'/g, `'\\''`)}'`; }
