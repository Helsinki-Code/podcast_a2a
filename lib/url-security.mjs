import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

function privateV4(address) {
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

export function isPrivateAddress(address) {
  if (isIP(address) === 4) return privateV4(address);
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value) || value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.');
  }
  return false;
}

export async function assertPublicHttpUrl(input, { resolve = true } = {}) {
  let url;
  try { url = new URL(String(input || '')); } catch { throw new Error('Enter a valid application URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Application URLs must begin with http:// or https://.');
  if (url.username || url.password) throw new Error('Do not put credentials inside the application URL.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || isPrivateAddress(hostname)) throw new Error('Private network and local URLs cannot be opened by a production agent.');
  if (resolve) {
    let records;
    try { records = await lookup(hostname, { all: true, verbatim: true }); }
    catch { throw new Error(`The hostname ${hostname} could not be resolved.`); }
    if (!records.length || records.some(record => isPrivateAddress(record.address))) throw new Error('The URL resolves to a private or restricted network address.');
  }
  return url.toString();
}
