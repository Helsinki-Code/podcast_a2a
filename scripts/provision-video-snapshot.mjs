import '../lib/env.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Sandbox } from '@vercel/sandbox';
import { installAgentBrowserInVercelSandbox } from '@agent-browser/sandbox/vercel';

if (!process.env.AGENT_BROWSER_SNAPSHOT_ID) {
  const pulled = spawnSync('vercel', ['env', 'pull', '/tmp/sales-forge-production.env', '--environment', 'production', '--yes'], { encoding: 'utf8' });
  if (pulled.status) throw new Error(pulled.stderr || pulled.stdout);
  const raw = readFileSync('/tmp/sales-forge-production.env', 'utf8');
  const match = raw.match(/^AGENT_BROWSER_SNAPSHOT_ID=(.*)$/m);
  if (match) process.env.AGENT_BROWSER_SNAPSHOT_ID = match[1].replace(/^['"]|['"]$/g, '');
}
if (!process.env.AGENT_BROWSER_SNAPSHOT_ID) throw new Error('AGENT_BROWSER_SNAPSHOT_ID is missing from the production Vercel environment.');
let sandbox;
try {
  sandbox = await Sandbox.create({ source: { type: 'snapshot', snapshotId: process.env.AGENT_BROWSER_SNAPSHOT_ID }, timeout: 20 * 60 * 1000 });
} catch (error) {
  if (!/snapshot not found/i.test(error.message)) throw error;
  sandbox = await Sandbox.create({ runtime: 'node24', timeout: 20 * 60 * 1000 });
  await installAgentBrowserInVercelSandbox(sandbox);
}
try {
  const toolsRoot = '/home/oai/share/video-tools';
  let result = await sandbox.runCommand('npm', ['install', '--prefix', toolsRoot, 'ffmpeg-static', 'ffprobe-static'], { timeoutMs: 10 * 60 * 1000 });
  if (result.exitCode) throw new Error(await result.stderr());
  const links = `const fs=require('fs');const root='${toolsRoot}/node_modules';for(const[n,p]of[['ffmpeg',require(root+'/ffmpeg-static')],['ffprobe',require(root+'/ffprobe-static').path]]){try{fs.unlinkSync('/usr/local/bin/'+n)}catch{}fs.symlinkSync(p,'/usr/local/bin/'+n)}`;
  result = await sandbox.runCommand('sudo', ['node', '-e', links]);
  if (result.exitCode) throw new Error(await result.stderr());
  result = await sandbox.runCommand('sh', ['-lc', 'ffmpeg -version | head -1; ffprobe -version | head -1; agent-browser --version']);
  if (result.exitCode) throw new Error(await result.stderr());
  console.log(await result.stdout());
  const snapshot = await sandbox.snapshot({ expiration: 0 });
  for (const target of ['production', 'preview', 'development']) {
    const changed = spawnSync('vercel', ['env', 'add', 'AGENT_BROWSER_SNAPSHOT_ID', target, '--value', snapshot.snapshotId, '--force'], { encoding: 'utf8' });
    if (changed.status) throw new Error(changed.stderr || changed.stdout);
  }
  console.log(`video snapshot: ${snapshot.snapshotId}`);
} catch (error) {
  await sandbox.stop().catch(() => {});
  throw error;
}
