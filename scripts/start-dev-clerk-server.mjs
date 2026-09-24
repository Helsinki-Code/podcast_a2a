import { readFile } from 'node:fs/promises';
import http from 'node:http';

const envFile = process.env.CLERK_E2E_ENV_FILE || '/tmp/sales-forge-clerk-dev.env';
for (const line of (await readFile(envFile, 'utf8')).split('\n')) {
  const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}
const { handler } = await import('../server.mjs');
const port = Number(process.env.PORT || 3381);
http.createServer(handler).listen(port, '127.0.0.1', () => console.log(`Sales Forge E2E: http://127.0.0.1:${port}`));
