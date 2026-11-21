// Browser-driven Qwen OTP registration.
//
// qwen.ai requests its email OTP through auth.qwen.ai. That endpoint is
// protected by the same Aliyun WAF as z.ai, so the request must be made from a
// real browser session with a fresh IP/session per retry. This module drives
// that session, solves the slider, waits for the mail-supplied code, submits it
// and returns the resulting account token/cookies.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { AUTH_URL, UA, extractToken, isWafHtml, requestSucceeded, verifySucceeded, classifyFailure } from './qwen.js';
import { solveSliderAuto } from './slider.js';
import { proxyForPlaywright } from './proxy.js';

const HOOK_JS = `
window.__qwenAuthEvents = [];
(function () {
  function rec(e) { try { window.__qwenAuthEvents.push(e); } catch (_) {} }
  var of = window.fetch;
  window.fetch = function () {
    var args = arguments;
    var req = args[0];
    var url = String(req && req.url ? req.url : req);
    var init = args[1] || {};
    if (url.indexOf('/api/v2/auths/') >= 0) {
      rec({ kind: 'request', url: url, method: init.method || (req && req.method) || 'GET', body: init.body || null });
    }
    return of.apply(this, arguments).then(function (res) {
      if (url.indexOf('/api/v2/auths/') >= 0) {
        try {
          res.clone().text().then(function (text) {
            rec({ kind: 'response', url: url, status: res.status, text: String(text || '').slice(0, 6000) });
          });
        } catch (_) {}
      }
      return res;
    });
  };
  var oo = XMLHttpRequest.prototype.open;
  var os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__qwenUrl = String(u); return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    var u = this.__qwenUrl || '';
    if (u.indexOf('/api/v2/auths/') >= 0) rec({ kind: 'request', url: u, method: 'XHR', body: body || null });
    return os.apply(this, arguments);
  };
})();
try {
  Object.defineProperty(navigator, 'webdriver', { get: function () { return undefined; } });
  Object.defineProperty(navigator, 'languages', { get: function () { return ['en-US', 'en']; } });
  Object.defineProperty(navigator, 'language', { get: function () { return 'en-US'; } });
  Object.defineProperty(navigator, 'platform', { get: function () { return 'Win32'; } });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: function () { return 8; } });
  Object.defineProperty(navigator, 'deviceMemory', { get: function () { return 8; } });
  if (!window.chrome) window.chrome = {};
  window.chrome.runtime = window.chrome.runtime || {};
  Object.defineProperty(navigator, 'userAgentData', {
    get: function () {
      return {
        brands: [
          { brand: 'Chromium', version: '125' },
          { brand: 'Google Chrome', version: '125' },
          { brand: 'Not?A_Band', version: '8' }
        ],
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: function () { return Promise.resolve({}); }
      };
    }
  });
  var origQuery = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = function (p) {
    if (p && p.name === 'notifications') return Promise.resolve({ state: Notification.permission });
    return origQuery(p);
  };
} catch (e) {}
`;

// Discover an installed Chromium browser from environment variables and
// standard OS locations. No machine-specific path is stored in the repo.
export function resolveBrowserChannel() {
  const pf = process.env.ProgramFiles;
  const pf86 = process.env['ProgramFiles(x86)'];
  const local = process.env.LOCALAPPDATA;
  const home = process.env.HOME || process.env.USERPROFILE;
  const join = (base, ...parts) => (base ? path.join(base, ...parts) : null);

  const candidates = [
    ['chrome', join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['chrome', join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['chrome', join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['chrome', join(home, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['chrome', '/usr/bin/google-chrome'],
    ['chrome', '/usr/bin/chromium'],
    ['chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['msedge', join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['msedge', join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['msedge', join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['msedge', '/usr/bin/microsoft-edge'],
    ['msedge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ];
  for (const [channel, file] of candidates) {
    if (file && existsSync(file)) return channel;
  }
  return null;
}

async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch {
    throw new Error('playwright-core not installed — run npm install');
  }
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

function makeEventStore(page, log) {
  const events = [];
  const state = { otpRequested: false, verify: null, waf: false };

  page.on('request', (req) => {
    try {
      const url = req.url();
      if (req.method() !== 'POST' || !/auth\.qwen\.ai\/api\/v2\/auths\//.test(url)) return;
      const body = req.postData();
      events.push({ kind: 'request', url, method: req.method(), body });
      if (/otp\/email\/request/.test(url) && body) state.lastOtpBody = body;
    } catch {
      /* listener must never throw */
    }
  });

  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (!/auth\.qwen\.ai\/api\/v2\/auths\//.test(url)) return;
      const text = (await resp.text()).slice(0, 6000);
      const parsed = parseMaybeJson(text);
      events.push({ kind: 'response', url, status: resp.status(), text, parsed });

      if (/otp\/email\/request/.test(url)) {
        if (isWafHtml(text)) {
          state.waf = true;
          const q = new URL(url).searchParams;
          if (q.get('u_asig')) log('  [qwen] WAF challenge still active after slider retry');
        } else if (requestSucceeded(parsed)) {
          state.otpRequested = true;
          log('  [qwen] OTP request accepted');
        } else {
          log(`  [qwen] OTP request rejected: ${String(text).replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }
      if (/otp\/email\/verify/.test(url)) {
        if (parsed && parsed.success === true && parsed.data) {
          const token = extractToken(parsed);
          state.verify = { ...parsed, token, user: parsed.data.user || parsed.data };
          log(token ? '  [qwen] OTP verified, token captured' : '  [qwen] OTP verified — token will be read from storage');
        } else {
          state.verifyError = classifyFailure({ status: resp.status(), data: parsed?.data, text });
        }
      }
    } catch {
      /* ignore response parse failures */
    }
  });

  return { events, state };
}

async function startSession({ proxy, proxyBypass, channel, headless, log }) {
  const pw = await loadPlaywright();
  const ch = channel || resolveBrowserChannel();
  if (!ch) throw new Error('no Chrome/Edge found — pass --browser chrome|msedge or install a browser');
  log(`  [browser] launching ${ch}${headless ? ' headless' : ''}`);

  const browser = await pw.chromium.launch({
    channel: ch,
    headless,
    proxy: proxyForPlaywright(proxy, proxyBypass),
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--disable-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      colorScheme: 'light',
    });
    if (!process.env.QWEN_NO_STEALTH) await context.addInitScript(HOOK_JS);
    const page = await context.newPage();
    return { browser, context, page };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

async function codeInputsVisible(page) {
  try {
    return (await page.locator('.qwenchat-verification-code-input-cell').count()) >= 6;
  } catch {
    return false;
  }
}

async function wafPresent(page) {
  for (const frame of page.frames()) {
    try {
      const n = await frame.locator(
        '#aliyunCaptcha-sliding-slider, #aliyunCaptcha-window-embed, #waf_nc_block'
      ).count();
      if (n > 0) return true;
    } catch {
      /* frame may be gone */
    }
  }
  return false;
}

async function dismissSplash(page, log) {
  const splash = page.locator('#splash-screen, #splash-main-container');
  try {
    await splash.first().waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
    const n = await splash.count();
    if (n > 0) {
      const stillVisible = await splash.first().isVisible().catch(() => false);
      if (stillVisible) {
        log('  [form] removing blocking splash overlay');
        await page.evaluate(() => {
          for (const el of document.querySelectorAll('#splash-screen, #splash-main-container')) el.remove();
        }).catch(() => {});
      }
    }
  } catch {
    /* splash handling must never abort registration */
  }
}

async function fillEmail(page, email, log) {
  await dismissSplash(page, log);
  const input = page.locator('.qwenchat-email-otp-panel input[name="email"]').first();
  await input.waitFor({ state: 'visible', timeout: 20000 });
  await input.fill(email);
  log(`  [form] email: ${email}`);
  const button = page.locator('.qwenchat-email-otp-panel button:has-text("Continue")').first();
  await button.waitFor({ state: 'visible', timeout: 10000 });
  await sleep(300);
  await dismissSplash(page, log);
  await button.click({ timeout: 10000 });
  log('  [form] Continue clicked');
}

async function submitCode(page, code, log) {
  const cells = page.locator('.qwenchat-verification-code-input-cell');
  await cells.first().waitFor({ state: 'visible', timeout: 15000 });
  const clean = String(code).replace(/\D/g, '').slice(0, 6);
  if (clean.length !== 6) throw new Error('Qwen OTP must contain 6 digits');

  // The cells are real <input maxlength=1> elements. Filling them in order
  // mirrors typing: React moves focus and builds the full 6-digit value.
  for (let i = 0; i < 6; i += 1) {
    const cell = cells.nth(i);
    await cell.fill(clean[i]);
    await sleep(80);
  }
  log('  [form] verification code filled');
  await sleep(300);

  const verifyButton = page.locator('.qwenchat-email-otp-panel button:has-text("Continue")').last();
  await verifyButton.waitFor({ state: 'visible', timeout: 10000 });
  await dismissSplash(page, log);
  await verifyButton.click({ timeout: 10000 });
  log('  [form] Continue clicked to verify code');
}

async function runRound(opts) {
  const {
    email,
    proxy,
    proxyBypass,
    channel,
    headless,
    autoAttempts,
    timeoutMs,
    log,
    onRetry,
    getCode,
  } = opts;

  const session = await startSession({ proxy, proxyBypass, channel, headless, log });
  const { browser, context, page } = session;
  const store = makeEventStore(page, log);

  try {
    log('  [browser] opening Qwen signup');
    await page.goto(AUTH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1800);
    await fillEmail(page, email, log);

    const stage = await waitUntil(async () => {
      if (store.state.otpRequested || (await codeInputsVisible(page))) return 'otp';
      if (await wafPresent(page)) return 'waf';
      return null;
    }, 25000);

    if (stage === 'waf') {
      log('  [captcha] Aliyun WAF detected — solving slider');
      const outcome = await solveSliderAuto({
        page,
        proxy,
        onRetry,
        referer: AUTH_URL,
        attempts: autoAttempts,
        acceptPassLabels: false,
        singleDrag: true,
        log,
        isSolved: () => store.state.otpRequested || false,
      });
      log(`  [captcha] slider result: ${outcome}`);
    }

    const accepted = await waitUntil(async () => {
      if (store.state.otpRequested) return true;
      if (await codeInputsVisible(page)) return true;
      return null;
    }, Math.min(timeoutMs, 30000));

    if (!accepted) {
      const detail = store.state.waf
        ? 'Aliyun WAF rejected this browser session'
        : 'OTP request never reached the code stage';
      const err = new Error(detail);
      err.kind = store.state.waf ? 'waf_block' : 'otp_request';
      throw err;
    }

    if (!(await codeInputsVisible(page))) {
      await waitUntil(() => codeInputsVisible(page), 15000);
    }

    log('  [mail] waiting for OTP code');
    const mail = await getCode(log);
    if (!mail || !mail.code) {
      const err = new Error('OTP mail timeout');
      err.kind = 'mail_timeout';
      throw err;
    }

    await submitCode(page, mail.code, log);

    const verified = await waitUntil(() => store.state.verify || store.state.verifyError, 45000);
    if (!verified) throw new Error('OTP verification produced no response');

    if (store.state.verifyError && !store.state.verify) {
      const err = new Error(store.state.verifyError.message);
      err.kind = store.state.verifyError.kind;
      throw err;
    }

    let token = store.state.verify.token;
    if (!token) {
      token = await page.evaluate(() => localStorage.getItem('active_token') || '').catch(() => '');
    }
    if (!token) throw new Error('account verified but no token captured');

    const user = store.state.verify.user || {};
    const cookies = (await context.cookies())
      .filter((c) => /qwen\.ai|alicdn\.com|taobao\.com/.test(c.domain || ''))
      .map(({ name, value, domain, path: cookiePath }) => ({ name, value, domain, path: cookiePath }));

    return {
      token,
      userId: user.id || (await page.evaluate(() => window.userId || '').catch(() => '')) || null,
      email,
      user: {
        id: user.id || null,
        email: user.email || email,
        name: user.name || null,
        role: user.role || null,
      },
      cookies,
      events: store.events,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Register one account. Each round uses a brand-new browser context: Aliyun
 * keeps per-session risk state, so refreshing inside a dead session is much
 * less likely to pass than starting over.
 */
export async function registerQwenAccount(opts) {
  const log = opts.log || (() => {});
  const rounds = Number.isInteger(opts.captchaRounds) && opts.captchaRounds > 0 ? opts.captchaRounds : 2;
  let lastError = null;

  for (let round = 1; round <= rounds; round += 1) {
    if (round > 1) {
      const pause = 1500 + Math.floor(Math.random() * 2000);
      log(`  [browser] fresh session ${round}/${rounds} in ${(pause / 1000).toFixed(1)}s`);
      await sleep(pause);
    }
    try {
      return await runRound({ ...opts, log });
    } catch (err) {
      lastError = err;
      log(`  [browser] session ${round} failed: ${err.message}`);
      if (err.kind === 'mail_timeout' || err.kind === 'otp') throw err;
      if (err.kind === 'waf_block' && round < rounds) continue;
    }
  }
  throw lastError || new Error('Qwen registration failed');
}
