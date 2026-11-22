// CLI validation and config precedence, without network access.
// Run: node --test test/cli.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCli } from '../qwen-regger.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const runCli = (...args) =>
  spawnSync(process.execPath, ['qwen-regger.js', ...args], { cwd: ROOT, encoding: 'utf8' });

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cli-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function parse(args) {
  const saved = process.argv;
  process.argv = [process.execPath, path.join(ROOT, 'qwen-regger.js'), ...args];
  try {
    return parseCli();
  } finally {
    process.argv = saved;
  }
}

for (const args of [
  ['--count', '3abc'],
  ['--count', '2.5'],
  ['--count', '1e3'],
  ['--count', '0'],
  ['--interval=-1'],
  ['--auto-attempts', 'nope'],
  ['--captcha-rounds', '0'],
  ['--captcha-timeout', 'abc'],
  ['--email-timeout', '0'],
]) {
  test(`${args.join(' ')} is rejected`, () => {
    const r = runCli(...args);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /must be an integer >= \d+/);
  });
}

test('--code is validated as exactly 6 digits', (t) => {
  const base = ['--provider', 'code', '--email', 'user@example.test'];
  for (const code of ['abc123456', '12345', '1234567']) {
    const r = runCli(...base, '--code', code);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /6-digit OTP/);
  }
  const cfg = parse(['--config', path.join(tempDir(t), 'missing.json'), ...base, '--code', '012345']);
  assert.equal(cfg.code, '012345');
});

test('--help exits 0', () => {
  const r = runCli('--help');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--proxy-file/);
  assert.match(r.stdout, /--captcha-timeout/);
});

test('config supplies values that the CLI did not set', (t) => {
  const file = path.join(tempDir(t), 'config.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      headless: false,
      out: 'from-config.json',
      proxy: 'socks5://127.0.0.1:1080',
      mailBase: 'https://mail.example',
      mailPass: 'secret',
      mailDomain: 'example.test',
      provider: 'cfmail',
      interval: 7,
    }),
    'utf8'
  );

  const cfg = parse(['--config', file]);
  assert.equal(cfg.headless, false);
  assert.equal(cfg.out, path.resolve('from-config.json'));
  assert.equal(cfg.proxy, 'socks5://127.0.0.1:1080');
  assert.equal(cfg.mailBase, 'https://mail.example');
  assert.equal(cfg.mailPass, 'secret');
  assert.equal(cfg.mailDomain, 'example.test');
  assert.equal(cfg.provider, 'cfmail');
  assert.equal(cfg.interval, 7);

  const overridden = parse(['--config', file, '--interval', '3', '--proxy', 'none', '--headed']);
  assert.equal(overridden.interval, 3);
  assert.equal(overridden.proxy, null);
  assert.equal(overridden.headless, false);
});

test('--headed overrides headless from config', (t) => {
  const file = path.join(tempDir(t), 'config.json');
  fs.writeFileSync(file, '{"headless": true}', 'utf8');
  assert.equal(parse(['--config', file]).headless, true);
  assert.equal(parse(['--config', file, '--headed']).headless, false);
});
