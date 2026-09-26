import '../lib/env.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Sandbox } from '@vercel/sandbox';
import { installAgentBrowserInVercelSandbox } from '@agent-browser/sandbox/vercel';
import { DESKTOP_START_SCRIPT } from '../lib/vercel-sandbox.mjs';

function productionValue(name) {
  const pulled = spawnSync('vercel', ['env', 'pull', '/tmp/sales-forge-computer-use.env', '--environment', 'production', '--yes'], { encoding: 'utf8' });
  if (pulled.status) throw new Error(pulled.stderr || pulled.stdout);
  const raw = readFileSync('/tmp/sales-forge-computer-use.env', 'utf8');
  return raw.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.replace(/^['"]|['"]$/g, '') || '';
}

const baseSnapshot = process.env.AGENT_BROWSER_SNAPSHOT_ID || productionValue('AGENT_BROWSER_SNAPSHOT_ID');
let sandbox;
try {
  sandbox = baseSnapshot
    ? await Sandbox.create({ source: { type: 'snapshot', snapshotId: baseSnapshot }, timeout: 30 * 60 * 1000 })
    : await Sandbox.create({ runtime: 'node24', timeout: 30 * 60 * 1000 });
} catch (error) {
  if (!/snapshot not found/i.test(error.message)) throw error;
  sandbox = await Sandbox.create({ runtime: 'node24', timeout: 30 * 60 * 1000 });
}

async function run(label, command, args, timeoutMs = 10 * 60 * 1000) {
  console.log(label);
  const result = await sandbox.runCommand(command, args, { timeoutMs });
  if (result.exitCode !== 0) throw new Error(`${label}: ${(await result.stderr()).slice(-3000)}`);
  return result;
}

// The same script the app uploads before each desktop start (see lib/vercel-sandbox.mjs).
const startup = DESKTOP_START_SCRIPT;

try {
  const hasAgentBrowser = await sandbox.runCommand('agent-browser', ['--version']);
  if (hasAgentBrowser.exitCode !== 0) await installAgentBrowserInVercelSandbox(sandbox);
  await run('Installing desktop packages', 'sudo', ['dnf', 'install', '-y', 'tigervnc-server', 'ImageMagick', 'python3-pip', 'gcc', 'make', 'libXtst-devel', 'libXinerama-devel', 'libxkbcommon-devel', 'libX11-devel', 'glib2-devel', 'libxml2-devel', 'pango-devel', 'libXrandr-devel', 'libXcursor-devel', 'libXft-devel', 'libXext-devel', 'pkgconf', 'xorg-x11-utils']);
  await run('Installing Google Chrome', 'sudo', ['dnf', 'install', '-y', 'https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm']);
  await run('Building xdotool', 'sh', ['-lc', 'cd /tmp && curl -fsSL https://github.com/jordansissel/xdotool/releases/download/v3.20211022.1/xdotool-3.20211022.1.tar.gz -o xdotool.tar.gz && tar xzf xdotool.tar.gz && cd xdotool-3.20211022.1 && make WITHOUT_RPATH_FIX=1 && sudo make PREFIX=/usr INSTALLMAN=/usr/share/man install && sudo ldconfig']);
  await run('Building Openbox', 'sh', ['-lc', 'cd /tmp && curl -fsSL http://openbox.org/dist/openbox/openbox-3.6.1.tar.gz -o openbox.tar.gz && tar xzf openbox.tar.gz && cd openbox-3.6.1 && ./configure --prefix=/usr --disable-nls && make -j$(nproc) && sudo make install && sudo ldconfig']);
  await run('Installing noVNC', 'sh', ['-lc', 'sudo pip3 install websockify && sudo git clone --depth 1 https://github.com/novnc/noVNC.git /usr/share/novnc && sudo ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html']);
  await sandbox.writeFiles([{ path: '/tmp/start-sales-forge-desktop.sh', content: Buffer.from(startup) }]);
  await run('Installing desktop startup script', 'sudo', ['sh', '-lc', 'mv /tmp/start-sales-forge-desktop.sh /usr/local/bin/start-sales-forge-desktop.sh && chmod 755 /usr/local/bin/start-sales-forge-desktop.sh']);
  const toolsRoot = '/home/oai/share/video-tools';
  await run('Installing FFmpeg', 'npm', ['install', '--prefix', toolsRoot, 'ffmpeg-static', 'ffprobe-static']);
  const links = `const fs=require('fs');const root='${toolsRoot}/node_modules';for(const[n,p]of[['ffmpeg',require(root+'/ffmpeg-static')],['ffprobe',require(root+'/ffprobe-static').path]]){try{fs.unlinkSync('/usr/local/bin/'+n)}catch{}fs.symlinkSync(p,'/usr/local/bin/'+n)}`;
  await run('Linking FFmpeg', 'sudo', ['node', '-e', links]);
  await run('Checking desktop runtime', '/usr/local/bin/start-sales-forge-desktop.sh', ['snapshot-check'], 120000);
  await run('Checking control tools', 'sh', ['-lc', 'DISPLAY=:99 import -window root /tmp/desktop-check.png && test -s /tmp/desktop-check.png && curl -fsS http://127.0.0.1:9222/json/version && agent-browser --session snapshot-check connect http://127.0.0.1:9222 --json && agent-browser --session snapshot-check snapshot -i -c --json']);
  const snapshot = await sandbox.snapshot({ expiration: 0 });
  for (const target of ['production', 'preview', 'development']) {
    const changed = spawnSync('vercel', ['env', 'add', 'COMPUTER_USE_SNAPSHOT_ID', target, '--value', snapshot.snapshotId, '--force'], { encoding: 'utf8' });
    if (changed.status) throw new Error(changed.stderr || changed.stdout);
  }
  console.log(`computer use snapshot: ${snapshot.snapshotId}`);
} catch (error) {
  await sandbox.stop().catch(() => {});
  throw error;
}
