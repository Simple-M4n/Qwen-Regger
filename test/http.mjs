// HTTP transport helpers and SOCKS5 address encoding.
// Run: node --test test/http.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { HttpError, Transport, isRetryableConnectError, socks5Address } from '../lib/http.js';

test('connect-phase errors are classified for retry', () => {
  assert.equal(isRetryableConnectError({ code: 'ECONNREFUSED' }), true);
  assert.equal(isRetryableConnectError({ code: 'EAI_AGAIN' }), true);
  assert.equal(isRetryableConnectError(new HttpError('proxy CONNECT timeout')), true);
  assert.equal(isRetryableConnectError({ message: 'socks proxy authentication failed' }), true);
  assert.equal(isRetryableConnectError(new Error('HTTP 500')), false);
  assert.equal(isRetryableConnectError(null), false);
});

test('every SOCKS connect rejection is classified for retry', () => {
  for (const message of [
    'socks proxy connect rejected (code 2)',
    'socks proxy connect rejected',
    'socks proxy server requested authentication',
    'socks proxy connect failed',
    'socks proxy connect timeout',
  ]) {
    assert.equal(isRetryableConnectError(new Error(message)), true, message);
  }
});

test('SOCKS5 address encodes IPv4, IPv6 and domains', () => {
  assert.deepEqual([...socks5Address('127.0.0.1')], [1, 127, 0, 0, 1]);
  const v6 = socks5Address('::1');
  assert.equal(v6[0], 4);
  assert.equal(v6.length, 17);
  assert.equal(v6[16], 1);

  const domain = socks5Address('example.test');
  assert.equal(domain[0], 3);
  assert.equal(domain[1], 12);
  assert.equal(domain.subarray(2).toString(), 'example.test');
});

test('SOCKS5 rejects a domain longer than 255 bytes', () => {
  const host = `${'a'.repeat(64)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`;
  assert.throws(() => socks5Address(host), /too long for SOCKS5/);
});

test('transport rejects invalid URLs instead of retrying', async () => {
  await assert.rejects(new Transport().request('not-a-url'), /invalid URL/);
});

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('Authorization is stripped on cross-origin redirects', async () => {
  let seenAuth = 'not-called';
  const target = http.createServer((req, res) => {
    seenAuth = req.headers.authorization || null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  const targetPort = await listen(target);
  const source = http.createServer((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/` });
    res.end();
  });
  const sourcePort = await listen(source);
  try {
    await new Transport().request(`http://127.0.0.1:${sourcePort}/`, {
      headers: { Authorization: 'Bearer secret' },
    });
    assert.equal(seenAuth, null);
  } finally {
    await new Promise((r) => source.close(r));
    await new Promise((r) => target.close(r));
  }
});
