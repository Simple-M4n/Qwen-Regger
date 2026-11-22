#!/usr/bin/env node
// qwen-regger — non-interactive account registration for chat.qwen.ai.
// Control surface: config.json plus CLI flags only. No prompts, no TUI, no chat.

import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, writeJson, ACCOUNTS_FILE } from './lib/store.js';
import { buildProvider } from './lib/mail.js';
import { Transport, sleep } from './lib/http.js';
import { QwenClient } from './lib/qwen.js';
import { registerQwenAccount, resolveBrowserChannel } from './lib/browser.js';
import {
  normalizeProxy,
  normalizeProxyType,
  proxyForPlaywright,
  describeProxy,
  parseProxyList,
  createRotator,
} from './lib/proxy.js';

const USAGE = `
qwen-regger — automated registration for https://chat.qwen.ai

Usage: node qwen-regger.js [options]

Every setting can be placed in config.json; CLI flags override it for one run.

Config:
  --config FILE            alternative config.json path (env: QWEN_REGGER_CONFIG)

Account / batch:
  --count N                accounts to register (default 1)
  --provider K             mailtm | tempmail | guerrilla | cfmail | code
                           code = use --email + --code, no mailbox polling
  --email ADDR             email for provider=code
  --code CODE              6-digit OTP for provider=code
  --out FILE               output file (default: outside the repo)
  --interval SEC           pause between accounts (default 65)

Mailbox (cfmail):
  --mail-base URL          cfmail instance base URL
  --mail-pass PASS         cfmail site password
  --mail-domain DOM        cfmail address domain

Captcha / timing:
  --auto-attempts N        slider attempts per browser session (default 10)
  --captcha-rounds N       fresh browser sessions after a failed round (default 2)
  --captcha-timeout SEC    max wait for WAF/OTP stage (default 300)
  --email-timeout SEC      wait for OTP mail (default 180)

Network / browser:
  --proxy URL              http(s)://[user:pass@]host:port or
                           socks4:// / socks4a:// / socks5:// / socks5h://
  --proxy-type TYPE        http | https | socks4 | socks4a | socks5 | socks5h
                           (used when --proxy is a bare host:port)
  --proxy-file FILE        one proxy per line (or JSON array), rotated per account
  --proxy-bypass LIST      comma-separated hosts bypassing the proxy (browser)
  --insecure               skip TLS checks in Node and the browser
  --browser CHANNEL        chrome | msedge | chromium (default: autodetect)
  --headed                 visible browser window instead of headless

Misc:
  --selftest               network/mailbox/browser checks (creates a test mailbox)
  --verbose                detailed slider/mail/network diagnostics
  -h, --help               this help
`;

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

// Number.parseInt silently accepts "3abc" and "1e3". Configuration is user
// input too, so apply the same strict check to CLI values and config values.
function intFlag(raw, name, min) {
  const text = String(raw);
  if (!/^\d+$/.test(text)) fail(`${name} must be an integer >= ${min}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min) fail(`${name} must be an integer >= ${min}`);
  return value;
}

// parseArgs treats "--interval -1" as an ambiguous option instead of a value,
// so hidden invalid values never reach intFlag(). Join negative numbers to
// their option before parsing to keep validation messages consistent.
const NUMERIC_OPTIONS = new Set([
  'count',
  'interval',
  'auto-attempts',
  'captcha-rounds',
  'captcha-timeout',
  'email-timeout',
]);

function normalizeArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (
      arg.startsWith('--') &&
      !arg.includes('=') &&
      NUMERIC_OPTIONS.has(arg.slice(2)) &&
      typeof next === 'string' &&
      /^-\d/.test(next)
    ) {
      out.push(`${arg}=${next}`);
      i += 1;
    } else {
      out.push(arg);
    }
  }
  return out;
}

export function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      args: normalizeArgv(process.argv.slice(2)),
      options: {
        config: { type: 'string' },
        count: { type: 'string' },
        provider: { type: 'string' },
        email: { type: 'string' },
        code: { type: 'string' },
        out: { type: 'string' },
        interval: { type: 'string' },
        'mail-base': { type: 'string' },
        'mail-pass': { type: 'string' },
        'mail-domain': { type: 'string' },
        'auto-attempts': { type: 'string' },
        'captcha-rounds': { type: 'string' },
        'captcha-timeout': { type: 'string' },
        'email-timeout': { type: 'string' },
        proxy: { type: 'string' },
        'proxy-type': { type: 'string' },
        'proxy-file': { type: 'string' },
        'proxy-bypass': { type: 'string' },
        insecure: { type: 'boolean' },
        browser: { type: 'string' },
        headed: { type: 'boolean' },
        selftest: { type: 'boolean' },
        verbose: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(String(err.message || err));
    console.error(USAGE);
    process.exit(2);
  }

  const opt = parsed.values;
  if (opt.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const configPath = opt.config ? path.resolve(opt.config) : undefined;
  const defaults = loadConfig(configPath);
  const pick = (key, fallback) => (opt[key] !== undefined ? opt[key] : fallback);

  const count = intFlag(pick('count', 1), '--count', 1);

  const provider = String(pick('provider', defaults.provider || 'tempmail')).toLowerCase();
  if (!['mailtm', 'tempmail', 'guerrilla', 'cfmail', 'code'].includes(provider)) {
    fail('--provider must be mailtm | tempmail | guerrilla | cfmail | code');
  }
  const email = opt.email || defaults.email || null;
  const code = opt.code || defaults.code || null;
  if (provider === 'code') {
    if (!email || !code) fail('provider=code requires --email and --code');
    if (!/^\d{6}$/.test(String(code))) fail('--code must be a 6-digit OTP');
    if (count > 1) fail('provider=code can only be used with --count 1');
  }

  const interval = intFlag(pick('interval', defaults.interval ?? 65), '--interval', 0);
  const autoAttempts = intFlag(pick('auto-attempts', defaults.autoAttempts ?? 10), '--auto-attempts', 1);
  const captchaRounds = intFlag(pick('captcha-rounds', defaults.captchaRounds ?? 2), '--captcha-rounds', 1);
  const captchaTimeout = intFlag(pick('captcha-timeout', defaults.captchaTimeout ?? 300), '--captcha-timeout', 1);
  const emailTimeout = intFlag(pick('email-timeout', defaults.emailTimeout ?? 180), '--email-timeout', 1);

  let proxyType;
  let proxy;
  try {
    proxyType = opt['proxy-type'] ? normalizeProxyType(opt['proxy-type']) : defaults.proxyType || null;
    proxy = normalizeProxy(pick('proxy', defaults.proxy ?? null), proxyType);
  } catch (err) {
    fail(err.message);
  }

  const proxyFile = opt['proxy-file'] || defaults.proxyFile || null;
  let proxyList = [];
  if (proxyFile) {
    try {
      proxyList = parseProxyList(fs.readFileSync(path.resolve(proxyFile), 'utf8'), proxyType);
    } catch (err) {
      fail(err.message);
    }
  }

  return {
    count,
    provider,
    email,
    code,
    out: path.resolve(pick('out', defaults.out || ACCOUNTS_FILE)),
    interval,
    mailBase: pick('mail-base', defaults.mailBase || null),
    mailPass: pick('mail-pass', defaults.mailPass || null),
    mailDomain: pick('mail-domain', defaults.mailDomain || null),
    autoAttempts,
    captchaRounds,
    captchaTimeoutMs: captchaTimeout * 1000,
    emailTimeoutMs: emailTimeout * 1000,
    proxyType,
    proxy,
    proxyFile,
    proxyList,
    proxyBypass: pick('proxy-bypass', defaults.proxyBypass || null),
    insecure: opt.insecure !== undefined ? !!opt.insecure : !!defaults.insecure,
    browser: opt.browser || defaults.browser || null,
    headless: opt.headed ? false : defaults.headless !== false,
    selftest: !!opt.selftest,
    verbose: opt.verbose !== undefined ? !!opt.verbose : !!defaults.verbose,
  };
}

const ts = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`[${ts()}] ${msg}`);
const onRetry = (url, err, attempt, backoff) =>
  log(`    [retry ${attempt}] ${err.code || 'net'} ${String(err.message).slice(0, 90)} — ${backoff}ms`);

async function selftest(cfg) {
  let failures = 0;
  const check = (name, ok, detail) => {
    log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
  };

  const mail = new Transport({ proxy: cfg.proxy, timeout: 20000, insecure: cfg.insecure });
  const domains = await mail.json('https://api.mail.tm/domains').catch((e) => ({ status: 0, text: e.message }));
  check('mail.tm reachable', domains.status === 200 && !!domains.data?.['hydra:member']?.length, `HTTP ${domains.status}`);

  const qwen = new QwenClient({ ...cfg, onRetry });
  const conf = await qwen.config().catch((e) => ({ status: 0, text: e.message }));
  check('chat.qwen.ai reachable', conf.status === 200, `HTTP ${conf.status}`);

  if (cfg.provider !== 'code') {
    const provider = buildProvider(cfg.provider, {
      proxy: cfg.proxy,
      insecure: cfg.insecure,
      onRetry,
      base: cfg.mailBase,
      sitePassword: cfg.mailPass,
      domain: cfg.mailDomain,
    });
    try {
      const inbox = await provider.createInbox();
      check(`mailbox via ${cfg.provider}`, !!inbox.address, inbox.address);
    } catch (err) {
      check(`mailbox via ${cfg.provider}`, false, err.message);
    }
  }

  const channel = cfg.browser || resolveBrowserChannel();
  check('browser available', !!channel, channel || 'none found — install Chrome/Edge or pass --browser');
  if (channel) {
    try {
      const pw = await import('playwright-core');
      const browser = await pw.chromium.launch({
        channel,
        headless: true,
        proxy: proxyForPlaywright(cfg.proxy, cfg.proxyBypass),
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled', '--disable-features=AutomationControlled'],
      });
      await browser.close();
      check('playwright-core launch', true, `channel=${channel}, proxy=${describeProxy(cfg.proxy)}`);
    } catch (err) {
      check('playwright-core launch', false, err.message.split('\n')[0]);
    }
  }

  log(failures === 0 ? 'selftest: all checks passed' : `selftest: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

function loadResults(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveResults(file, results) {
  writeJson(file, results);
}

async function registerOne(cfg, provider, rec) {
  const inbox = await provider.createInbox();
  rec.email = inbox.address;
  log(`    ${rec.email}`);

  const result = await registerQwenAccount({
    email: rec.email,
    proxy: cfg.proxy,
    proxyBypass: cfg.proxyBypass,
    channel: cfg.browser,
    headless: cfg.headless,
    insecure: cfg.insecure,
    autoAttempts: cfg.autoAttempts,
    captchaRounds: cfg.captchaRounds,
    timeoutMs: cfg.captchaTimeoutMs,
    onRetry,
    log: cfg.verbose ? (msg) => log(msg) : () => {},
    progress: (msg) => log(msg),
    getCode: (detailLog) =>
      provider.waitForVerifyMail(inbox, {
        timeout: cfg.emailTimeoutMs,
        log: cfg.verbose ? (msg) => log(msg) : (msg) => detailLog?.(msg),
      }),
  });

  rec.status = 'complete';
  rec.token = result.token;
  rec.user_id = result.userId;
  rec.user = result.user;
  rec.cookies = result.cookies;
  log(`    DONE user_id=${result.userId || 'n/a'}`);
  return rec;
}

async function main() {
  const cfg = parseCli();
  if (cfg.selftest) {
    await selftest(cfg);
    return;
  }

  const rotator = createRotator(cfg.proxyList, true);
  const makeProvider = (proxy) =>
    buildProvider(cfg.provider, {
      proxy,
      insecure: cfg.insecure,
      onRetry,
      base: cfg.mailBase,
      sitePassword: cfg.mailPass,
      domain: cfg.mailDomain,
      email: cfg.email,
      code: cfg.code,
    });

  log(`qwen-regger: ${cfg.count} account(s), provider=${cfg.provider}, proxy=${rotator ? `${rotator.size} rotated` : describeProxy(cfg.proxy)}`);
  if (!cfg.browser && !resolveBrowserChannel()) {
    fail('no Chrome/Edge found — pass --browser chrome|msedge or install a browser');
  }

  const results = loadResults(cfg.out);
  let ok = 0;
  let stop = false;

  for (let i = 1; i <= cfg.count; i += 1) {
    const rec = {
      index: results.length + 1,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    const accountCfg = rotator ? { ...cfg, proxy: rotator.next() } : cfg;
    const provider = makeProvider(accountCfg.proxy);
    if (rotator) log(`    network: ${describeProxy(accountCfg.proxy)}`);
    log(`──── account ${i}/${cfg.count} ────`);

    try {
      await registerOne(accountCfg, provider, rec);
      if (rec.status === 'complete') ok += 1;
    } catch (err) {
      rec.status = rec.status === 'pending' ? 'failed' : rec.status;
      rec.error = String(err.message || err);
      log(`FAILED: ${rec.error}`);
      if (err.kind === 'waf_block' && !rotator) {
        log('Aliyun WAF blocked this IP — stopping. Use --proxy-file to rotate exits.');
        stop = true;
      }
    }

    results.push(rec);
    try {
      saveResults(cfg.out, results);
    } catch (err) {
      log(`could not write ${cfg.out}: ${err.message}`);
    }
    if (stop) break;

    if (i < cfg.count) {
      log(`rate-limit pause ${cfg.interval}s before the next account...`);
      const until = Date.now() + cfg.interval * 1000;
      while (Date.now() < until) {
        const left = Math.ceil((until - Date.now()) / 1000);
        process.stdout.write(`\r[${ts()}] ${left}s left   `);
        await sleep(1000);
      }
      process.stdout.write('\n');
    }
  }

  const done = results.filter((r) => r.status === 'complete').length;
  log(`summary: ${done} complete in ${cfg.out} (this run: ${ok}/${cfg.count})`);
  process.exitCode = ok === cfg.count ? 0 : 1;
}

// Exporting parseCli keeps the CLI testable without starting a registration.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`fatal: ${err.stack || err.message || err}`);
    process.exitCode = 1;
  });
}
