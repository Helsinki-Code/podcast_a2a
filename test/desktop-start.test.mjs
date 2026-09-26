import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, writeFile, chmod, readlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DESKTOP_START_SCRIPT } from '../lib/vercel-sandbox.mjs';

// A resumed persistent sandbox keeps /tmp but not its processes, so Chrome's profile lock still
// names the old machine. The desktop start script must clear it; the display, window manager, and
// VNC bridge are stand-ins here, Chrome is real (headless).
let chrome = '';
try { chrome = (await import('playwright-core')).chromium.executablePath(); } catch {}
const tools = ['curl', 'pgrep', 'pkill'].every(tool => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0);
const portFree = spawnSync('curl', ['-fsS', '--max-time', '1', 'http://127.0.0.1:9222/json/version']).status !== 0;

// Force-stop the stand-in servers and wait until they are gone, so the next start sees no display.
function stopStandIns() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const alive = ['Xvnc', 'openbox', 'websockify'].filter(name => spawnSync('pgrep', ['-x', name]).status === 0);
    if (!alive.length) return;
    for (const name of alive) spawnSync('pkill', ['-KILL', '-x', name]);
    spawnSync('sleep', ['0.1']);
  }
}

test('the desktop start script recovers from a stale Chrome profile lock', { skip: !(chrome && existsSync(chrome) && tools && portFree && process.platform === 'linux') && 'needs Linux, Chromium, and a free port 9222' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-start-'));
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'google-chrome'), `#!/bin/bash\nexec "${chrome}" --headless=new "$@"\n`);
  // Shell stand-ins keep their own process name, so pgrep -x finds them like the real servers.
  // No xdpyinfo and no X socket: the snapshot may lack the tool, and a running Xvnc is enough.
  for (const name of ['Xvnc', 'openbox', 'websockify']) await writeFile(path.join(bin, name), '#!/bin/bash\nsleep 120\n');
  for (const name of ['google-chrome', 'Xvnc', 'openbox', 'websockify']) await chmod(path.join(bin, name), 0o755);
  const script = path.join(dir, 'start.sh');
  await writeFile(script, DESKTOP_START_SCRIPT);
  const session = `test${process.pid}`;
  const profile = `/tmp/chrome-profile-${session}`;
  await mkdir(profile, { recursive: true });
  await symlink('previous-machine-4242', path.join(profile, 'SingletonLock'));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  try {
    const first = spawnSync('bash', [script, session], { env, encoding: 'utf8', timeout: 90000 });
    assert.equal(first.status, 0, first.stderr);
    assert.notEqual(await readlink(path.join(profile, 'SingletonLock')).catch(() => ''), 'previous-machine-4242');
    assert.equal(spawnSync('curl', ['-fsS', 'http://127.0.0.1:9222/json/version']).status, 0);
    // A second start with Chrome already running returns straight away.
    assert.equal(spawnSync('bash', [script, session], { env, encoding: 'utf8', timeout: 30000 }).status, 0);
    // A display server that exits at once is reported with its log.
    stopStandIns();
    await writeFile(path.join(bin, 'Xvnc'), '#!/bin/bash\necho "Fatal server error: no screens" >&2\nexit 1\n');
    const broken = spawnSync('bash', [script, session], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /virtual display did not start[\s\S]*no screens/);
  } finally {
    spawnSync('pkill', ['-f', `user-data-dir=${profile}`]);
    stopStandIns();
    await rm(profile, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
