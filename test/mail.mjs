// Mailbox polling edge cases and random-string generation.
// Run: node --test test/mail.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { buildProvider, extractOtpCode, pollMailbox, randPassword, randStr } from '../lib/mail.js';

test('a transient message-detail error does not skip the message forever', async () => {
  let loads = 0;
  const result = await pollMailbox({
    fetchPage: async () => ['m1'],
    extractMessages: (ids) => ids.map((id) => ({ id })),
    loadMessage: async () => {
      loads += 1;
      if (loads === 1) throw new Error('temporary fetch failure');
      return 'Your Qwen verification code is 123456';
    },
    timeout: 200,
    interval: 1,
    initialWait: 0,
    log: () => {},
  });
  assert.equal(result?.code, '123456');
  assert.equal(loads, 2);
});

test('a message without a code is loaded only once', async () => {
  let loads = 0;
  const result = await pollMailbox({
    fetchPage: async () => ['m2'],
    extractMessages: (ids) => ids.map((id) => ({ id })),
    loadMessage: async () => {
      loads += 1;
      return 'no code here';
    },
    timeout: 30,
    interval: 1,
    initialWait: 0,
    log: () => {},
  });
  assert.equal(result, null);
  assert.equal(loads, 1);
});

test('random strings use the requested alphabet and length', () => {
  assert.match(randStr(24), /^[a-z0-9]{24}$/);
  assert.match(randPassword(20), /^[a-zA-Z0-9-_]{20}$/);
  assert.notEqual(randStr(16), randStr(16));
});

test('the fixed-code provider requires exactly six digits', async () => {
  const bad = buildProvider('code', { email: 'user@example.test', code: 'abc123456' });
  await assert.rejects(bad.createInbox(), /6-digit OTP/);

  const good = buildProvider('code', { email: 'user@example.test', code: '012345' });
  assert.equal((await good.createInbox()).address, 'user@example.test');
  assert.equal((await good.waitForVerifyMail()).code, '012345');
});

test('numeric HTML entities are decoded before OTP extraction', () => {
  assert.equal(extractOtpCode('Your code is &#54;&#53;&#52;&#51;&#50;&#49;.'), '654321');
  assert.equal(extractOtpCode('Your code is &#x36;&#x35;&#x34;&#x33;&#x32;&#x31;.'), '654321');
});

test('cfmail omits an unset x-custom-auth header', async () => {
  let headers = null;
  const server = http.createServer((req, res) => {
    headers = req.headers;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ address: 'user@example.test' }));
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  try {
    const provider = buildProvider('cfmail', { base: `http://127.0.0.1:${port}`, sitePassword: null });
    const inbox = await provider.createInbox();
    assert.equal(inbox.address, 'user@example.test');
    assert.equal(headers['x-custom-auth'], undefined);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
