import '../lib/env.mjs';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';

const sandbox = new VercelEpisodeSandbox(`check-${Date.now()}`, () => {});
const instance = await sandbox.ensure();
try {
  const result = await instance.runCommand('sh', ['-lc', 'command -v ffmpeg; ffmpeg -version | head -1; agent-browser --version']);
  console.log(await result.stdout());
  if (result.exitCode) throw new Error(await result.stderr());
} finally {
  await sandbox.close();
}
