import { spawn } from 'node:child_process';
import { inspectSandboxMedia, evaluateMediaQuality } from '../lib/media-quality.mjs';

const filenames = process.argv.slice(2).filter(value => !value.startsWith('--'));
const interactive = process.argv.includes('--interactive');
if (!filenames.length) throw new Error('Usage: node scripts/check-media-quality.mjs [--interactive] <video...>');

function command(program, args) {
  return new Promise(resolve => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => resolve({ exitCode: 127, stdout: async () => '', stderr: async () => error.message }));
    child.on('exit', code => resolve({ exitCode: code ?? 1, stdout: async () => Buffer.concat(stdout).toString(), stderr: async () => Buffer.concat(stderr).toString() }));
  });
}

const runner = { run: command };
let failed = false;
for (const filename of filenames) {
  try {
    const metrics = await inspectSandboxMedia(runner, filename, { sceneThreshold: .008, silenceNoise: '-30dB', silenceDuration: .25 });
    const verdict = evaluateMediaQuality(metrics, { interactive, minDuration: interactive ? 8 : 1, maxSilencePercent: 35, maxSilenceSeconds: 2 });
    console.log(JSON.stringify({ filename, verdict, metrics }, null, 2));
    if (!verdict.passed) failed = true;
  } catch (error) {
    failed = true;
    console.error(JSON.stringify({ filename, verdict: { passed: false, failures: [error.message] } }, null, 2));
  }
}
if (failed) process.exitCode = 1;
