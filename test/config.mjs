// Configuration loading and normalization. Run: node --test test/config.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG, loadConfig, normalizeConfig } from '../lib/store.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-config-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('missing config falls back to defaults', (t) => {
  const file = path.join(tempDir(t), 'missing.json');
  assert.deepEqual(loadConfig(file), normalizeConfig({}));
});

test('config accepts a UTF-8 BOM', (t) => {
  const file = path.join(tempDir(t), 'config.json');
  fs.writeFileSync(file, '\uFEFF{"count": 3, "provider": "code"}\n', 'utf8');
  const cfg = loadConfig(file);
  assert.equal(cfg.provider, 'code');
  assert.equal(DEFAULT_CONFIG.provider, 'tempmail');
});

test('config rejects invalid JSON and non-objects', (t) => {
  const dir = tempDir(t);
  const badJson = path.join(dir, 'bad.json');
  fs.writeFileSync(badJson, '{bad', 'utf8');
  assert.throws(() => loadConfig(badJson), /invalid config JSON/);

  const array = path.join(dir, 'array.json');
  fs.writeFileSync(array, '[]', 'utf8');
  assert.throws(() => loadConfig(array), /must contain a JSON object/);
});

test('normalizeConfig coerces string settings and normalizes the proxy', () => {
  const cfg = normalizeConfig({
    proxy: 'proxy.example:3128',
    proxyType: 'socks5',
    proxyBypass: 'localhost',
    mailBase: 'https://mail.example',
    mailPass: 'secret',
    mailDomain: 'example.test',
    out: 'accounts.json',
    headless: 0,
    insecure: 1,
  });
  assert.equal(cfg.proxy, 'socks5://proxy.example:3128');
  assert.equal(cfg.proxyType, 'socks5');
  assert.equal(cfg.proxyBypass, 'localhost');
  assert.equal(cfg.mailBase, 'https://mail.example');
  assert.equal(cfg.mailPass, 'secret');
  assert.equal(cfg.mailDomain, 'example.test');
  assert.equal(cfg.out, 'accounts.json');
  assert.equal(cfg.headless, true);
  assert.equal(cfg.insecure, true);
});
