import '../lib/env.mjs';
import { VercelEpisodeSandbox } from '../lib/vercel-sandbox.mjs';

const id = `resume-race-${Date.now()}`;
const clients = Array.from({ length: 4 }, () => new VercelEpisodeSandbox(id, () => {}));
try {
  const sandboxes = await Promise.all(clients.map(client => client.ensure()));
  const results = await Promise.all(sandboxes.map(sandbox => sandbox.runCommand('sh', ['-lc', 'printf resumed'])));
  const output = await Promise.all(results.map(result => result.stdout()));
  if (output.some(value => value !== 'resumed')) throw new Error(`Unexpected sandbox output: ${output.join(', ')}`);
  console.log(`sandbox resume race verified with ${sandboxes.length} concurrent clients`);
} finally {
  await clients[0].close().catch(() => {});
}
