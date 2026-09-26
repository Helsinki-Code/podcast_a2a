import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Test double for VercelEpisodeSandbox that runs ffmpeg/ffprobe on this machine. Paths under /tmp/
// are mapped into a private directory, and "screenshots" of stage HTML become solid PNG frames
// (the HTML itself is kept so tests can inspect it).
export function localSandboxClass(root) {
  mkdirSync(root, { recursive: true });
  const map = value => typeof value === 'string' ? value.replace(/(^|[\s'=:,])\/tmp\//g, `$1${root}/`) : value;
  return class LocalSandbox {
    constructor(id) { this.id = id; this.pages = []; }
    async run(program, args = [], timeoutMs = 600000) {
      const result = spawnSync(program, args.map(value => map(String(value))), { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
      return { exitCode: result.status ?? 1, stdout: async () => result.stdout || '', stderr: async () => result.stderr || String(result.error || '') };
    }
    async writeSandboxFile(filename, data) {
      const target = map(filename);
      mkdirSync(path.dirname(target), { recursive: true });
      // ffmpeg concat lists reference other sandbox paths, so remap those too.
      writeFileSync(target, typeof data === 'string' && filename.endsWith('.txt') ? data.replace(/'\/tmp\//g, `'${root}/`) : data);
    }
    async readSandboxFile(filename) { return readFileSync(map(filename)); }
    async setViewport() {}
    async command(args) {
      if (args[0] === 'open') this.lastPage = args[1].replace('file://', '');
      if (args[0] === 'screenshot') {
        this.pages.push(readFileSync(map(this.lastPage), 'utf8'));
        const color = ['0x1a2b3c', '0x2b3c4d', '0x3c4d5e'][this.pages.length % 3];
        const result = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=1920x1080`, '-frames:v', '1', map(args[1])], { encoding: 'utf8' });
        return { exitCode: result.status };
      }
      return { exitCode: 0 };
    }
    async close() {}
  };
}
