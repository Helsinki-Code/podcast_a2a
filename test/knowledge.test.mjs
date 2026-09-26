import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../lib/html-text.mjs';
import { publicFetch, isPrivateAddress } from '../lib/url-security.mjs';

test('web pages become readable knowledge text', () => {
  const page = htmlToText('<html><head><title>Guide &amp; FAQ</title><style>.x{}</style></head><body><nav>Menu</nav><h1>Setup</h1><p>Install the app&nbsp;now.</p><script>alert(1)</script><p>Then &#39;sync&#39;.</p><footer>©</footer></body></html>');
  assert.equal(page.title, 'Guide & FAQ');
  assert.equal(page.text, "Setup\nInstall the app now.\nThen 'sync'.");
});

test('redirects to private networks are refused on every hop', async () => {
  assert.equal(isPrivateAddress('100.100.1.1'), true, 'carrier-grade NAT is private');
  const original = globalThis.fetch;
  const hops = [];
  globalThis.fetch = async (url, options) => { hops.push([url, options.redirect]); return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/admin' } }); };
  try { await assert.rejects(publicFetch('http://93.184.216.34/start'), /Private network/); }
  finally { globalThis.fetch = original; }
  assert.deepEqual(hops, [['http://93.184.216.34/start', 'manual']]);
});
