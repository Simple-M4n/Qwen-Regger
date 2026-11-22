// Temporary mailbox providers and Qwen OTP extraction.
// Every provider is fully non-interactive: no prompts, no TUI, no chat.

import { randomBytes } from 'node:crypto';
import { Transport, sleep } from './http.js';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';

// Rejection sampling keeps every character uniformly distributed; a plain
// `byte % alphabet.length` slightly favours the first characters.
function randomString(alphabet, len) {
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = '';
  while (out.length < len) {
    for (const byte of randomBytes(Math.max(1, (len - out.length) * 2))) {
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === len) break;
    }
  }
  return out;
}

export function randStr(len) {
  return randomString(LETTERS, len);
}

export function randPassword(len = 16) {
  return randomString('abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_', len);
}

function numericEntity(digits, radix) {
  const cp = parseInt(digits, radix);
  return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => numericEntity(n, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => numericEntity(n, 16))
    .replace(/\\u0026/g, '&')
    .replace(/\\u003d/g, '=')
    .replace(/<[^>]+>/g, ' ');
}

/**
 * Extract the 6-digit Qwen verification code from an email body.
 * Scored by nearby context so unrelated six-digit numbers do not win.
 */
export function extractOtpCode(content) {
  if (!content) return null;
  const clean = decodeEntities(content).replace(/\s+/g, ' ');
  const candidates = [...clean.matchAll(/\b\d{6}\b/g)];
  if (!candidates.length) return null;

  const scored = candidates.map((match) => {
    const code = match[0];
    const idx = match.index;
    // Tight window keeps "verification code" attached to the right number and
    // prevents a nearby "order 123456" from contaminating the real OTP.
    const before = clean.slice(Math.max(0, idx - 25), idx).toLowerCase();
    const near = clean.slice(Math.max(0, idx - 25), idx + code.length + 25).toLowerCase();
    const wide = clean.slice(Math.max(0, idx - 100), idx + code.length + 100).toLowerCase();

    let score = 0;
    if (/(verification|verify|confirm|otp|code|验证码|код)[^0-9]{0,14}$/.test(before)) score += 10;
    if (/verification|verify|confirm|otp|code|验证码|код/.test(near)) score += 6;
    else if (/verification|verify|confirm|otp|code|验证码|код/.test(wide)) score += 2;
    if (/qwen|alibaba|aliyun|chat\.qwen\.ai/.test(near)) score += 4;
    else if (/qwen|alibaba|aliyun|chat\.qwen\.ai/.test(wide)) score += 2;
    if (/email|inbox|just sent/.test(near)) score += 2;
    if (/(order|invoice|ticket|phone|timestamp|sequence|serial|account id|user id)/.test(near)) score -= 10;
    if (/20\d{2}-\d{2}-\d{2}|20\d{10}/.test(near)) score -= 6;
    return { code, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 0) return null;
  return best.code;
}

function mailLooksRelevant(from, subject, content) {
  const text = `${from || ''} ${subject || ''}`.toLowerCase();
  if (/qwen|alibaba|aliyun|chat\.qwen\.ai/.test(text)) return true;
  if (/verification|verify|confirm|otp|code|验证|код/i.test(text)) return true;
  return !!extractOtpCode(content);
}

export async function pollMailbox({ fetchPage, extractMessages, loadMessage, inbox, timeout, interval, initialWait, log }) {
  if (initialWait > 0) await sleep(initialWait);
  const deadline = Date.now() + timeout;
  const seen = new Set();

  while (Date.now() < deadline) {
    let page = null;
    try {
      page = await fetchPage();
    } catch (err) {
      log(`  [mail] ${err.message}`);
    }
    const messages = page ? extractMessages(page) : [];

    for (const summary of messages) {
      const id = summary.id;
      if (id && seen.has(id)) continue;

      const from = summary.from || '';
      const subject = summary.subject || '';
      let content = summary.content || '';
      if (!content && loadMessage) {
        try {
          content = await loadMessage(summary);
        } catch (err) {
          // Keep the message eligible on the next poll: the body may arrive
          // after a transient API error.
          log(`  [mail] ${err.message}`);
          continue;
        }
      }
      if (id) seen.add(id);
      if (!mailLooksRelevant(from, subject, content)) continue;
      const code = extractOtpCode(content);
      if (!code) {
        log(`  [mail] message from "${from.trim()}" had no OTP code`);
        continue;
      }
      log(`  [mail] code from "${from.trim()}" subject="${subject}"`);
      return { content, subject, from: from.trim(), code };
    }

    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    log(`  [mail] waiting for Qwen code... ${left}s left`);
    await sleep(interval);
  }
  return null;
}

const DEFAULT_WAIT = { timeout: 180000, interval: 5000, initialWait: 6000 };

// ── mail.tm ──────────────────────────────────────────────────────

export class MailTmProvider {
  constructor({ proxy = null, timeout = 20000, insecure = false, onRetry = null } = {}) {
    this.name = 'mailtm';
    this.t = new Transport({ proxy, timeout, insecure, onRetry });
    this._domain = null;
  }

  async _domainName() {
    if (this._domain) return this._domain;
    const res = await this.t.json('https://api.mail.tm/domains');
    if (res.status >= 400) throw new Error(`mail.tm domains HTTP ${res.status}`);
    const members = res.data?.['hydra:member'] || [];
    const domain = members.find((d) => d.isActive && !d.isPrivate) || members.find((d) => d.isActive);
    if (!domain) throw new Error('mail.tm: no active domain available');
    this._domain = domain.domain;
    return this._domain;
  }

  async createInbox() {
    const domain = await this._domainName();
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const address = `${randStr(12)}@${domain}`;
      const password = randomBytes(9).toString('base64url');
      const acc = await this.t.json('https://api.mail.tm/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password }),
      });
      if (acc.status === 429) {
        await sleep(2000);
        continue;
      }
      if (acc.status >= 400) {
        lastErr = new Error(`mail.tm account create HTTP ${acc.status}`);
        continue;
      }
      const tok = await this.t.json('https://api.mail.tm/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password }),
      });
      if (tok.status >= 400 || !tok.data?.token) {
        throw new Error(`mail.tm token HTTP ${tok.status}`);
      }
      return { address, token: tok.data.token, accountId: tok.data.id };
    }
    throw lastErr || new Error('mail.tm: rate limited while creating an inbox');
  }

  waitForVerifyMail(inbox, options = {}) {
    const { log = () => {}, ...wait } = options;
    return pollMailbox({
      ...DEFAULT_WAIT,
      ...wait,
      log,
      fetchPage: async () => {
        const res = await this.t.json('https://api.mail.tm/messages?page=1', {
          headers: { Authorization: `Bearer ${inbox.token}` },
        });
        if (res.status === 401) throw new Error('mail.tm: inbox session rejected');
        if (res.status === 429) return null;
        if (res.status >= 400) throw new Error(`mail.tm messages HTTP ${res.status}`);
        return res.data?.['hydra:member'] || [];
      },
      extractMessages: (msgs) => (msgs || []).map((m) => ({
        id: m.id,
        from: `${m.from?.address || ''} ${m.from?.name || ''}`,
        subject: m.subject || '',
      })),
      loadMessage: async (msg) => {
        const res = await this.t.json(`https://api.mail.tm/messages/${msg.id}`, {
          headers: { Authorization: `Bearer ${inbox.token}` },
        });
        const d = res.data;
        return `${(d?.html || []).join('\n')}\n${d?.text || ''}`;
      },
    });
  }
}

// ── tempmail.lol ─────────────────────────────────────────────────

export class TempMailProvider {
  constructor({ proxy = null, timeout = 20000, insecure = false, onRetry = null } = {}) {
    this.name = 'tempmail';
    this.t = new Transport({ proxy, timeout, insecure, onRetry });
  }

  async createInbox() {
    const res = await this.t.json('https://api.tempmail.lol/v2/inbox/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res.status >= 400 || !res.data?.address || !res.data?.token) {
      throw new Error(`tempmail create HTTP ${res.status}: ${res.text.slice(0, 150)}`);
    }
    return { address: res.data.address, token: res.data.token };
  }

  waitForVerifyMail(inbox, options = {}) {
    const { log = () => {}, ...wait } = options;
    return pollMailbox({
      ...DEFAULT_WAIT,
      ...wait,
      log,
      fetchPage: async () => {
        const url = `https://api.tempmail.lol/v2/inbox?token=${encodeURIComponent(inbox.token)}`;
        const res = await this.t.json(url);
        return res.status < 400 ? res.data?.emails || [] : [];
      },
      extractMessages: (emails) => (emails || []).map((m) => ({
        id: m.id || m.message_id || m.email_id || '',
        from: m.from || '',
        subject: m.subject || '',
        content: `${m.html || ''}\n${m.body || ''}`,
      })),
    });
  }
}

// ── Guerrilla Mail ───────────────────────────────────────────────

export class GuerrillaProvider {
  constructor({ proxy = null, timeout = 20000, insecure = false, onRetry = null, domain = null } = {}) {
    this.name = 'guerrilla';
    this.t = new Transport({ proxy, timeout, insecure, onRetry });
    this.domain = domain;
  }

  async _api(params) {
    const url = `https://api.guerrillamail.com/ajax.php?${new URLSearchParams(params)}`;
    const res = await this.t.json(url, { retries: 1 });
    if (res.status >= 400) throw new Error(`guerrilla API HTTP ${res.status}`);
    if (!res.data || typeof res.data !== 'object') throw new Error('guerrilla API bad response');
    return res.data;
  }

  async createInbox() {
    const s = await this._api({ f: 'get_email_address' });
    if (!s.email_addr || !s.sid_token) throw new Error('guerrilla: no address in response');
    let address = s.email_addr;
    if (this.domain) {
      const user = address.split('@')[0];
      const alt = await this._api({ f: 'set_email_user', sid_token: s.sid_token, email_user: user, domain: this.domain });
      if (alt.email_addr) address = alt.email_addr;
    }
    return { address, token: s.sid_token };
  }

  waitForVerifyMail(inbox, options = {}) {
    const { log = () => {}, ...wait } = options;
    return pollMailbox({
      ...DEFAULT_WAIT,
      ...wait,
      log,
      fetchPage: () => this._api({ f: 'get_email_list', sid_token: inbox.token, offset: 0 }),
      extractMessages: (list) => (list?.list || []).map((m) => ({
        id: m.mail_id,
        from: m.mail_from || '',
        subject: m.mail_subject || '',
      })),
      loadMessage: async (msg) => {
        const full = await this._api({ f: 'fetch_email', sid_token: inbox.token, email_id: msg.id });
        return `${full.mail_body || ''}\n${full.mail_html || ''}\n${full.mail_text || ''}`;
      },
    });
  }
}

// ── self-hosted cloudflare_temp_email ───────────────────────────

export class CfMailProvider {
  constructor({ base, sitePassword = '', domain = null, proxy = null, timeout = 20000, insecure = false, onRetry = null } = {}) {
    if (!base) throw new Error('cfmail provider requires --mail-base https://your-mail-instance');
    this.name = 'cfmail';
    this.base = String(base).replace(/\/+$/, '');
    this.sitePassword = sitePassword;
    this.domain = domain;
    this.t = new Transport({ proxy, timeout, insecure, onRetry });
  }

  async createInbox() {
    const body = {};
    if (this.domain) body.domain = this.domain;
    const res = await this.t.json(`${this.base}/api/new_address`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.sitePassword ? { 'x-custom-auth': this.sitePassword } : {}),
      },
      body: JSON.stringify(body),
    });
    if (res.status >= 400 || !res.data?.address) {
      throw new Error(`cfmail create address HTTP ${res.status}`);
    }
    return { address: res.data.address, token: res.data.jwt || null };
  }

  waitForVerifyMail(inbox, options = {}) {
    const { log = () => {}, ...wait } = options;
    return pollMailbox({
      ...DEFAULT_WAIT,
      ...wait,
      log,
      fetchPage: async () => {
        const res = await this.t.json(`${this.base}/api/parsed_mails?limit=20&offset=0`, {
          headers: { Authorization: `Bearer ${inbox.token}` },
        });
        if (res.status >= 400) throw new Error(`cfmail parsed_mails HTTP ${res.status}`);
        return res.data?.results || [];
      },
      extractMessages: (mails) => (mails || []).map((m) => ({
        id: m.id,
        from: String(m.sender || m.source || ''),
        subject: m.subject || '',
        content: `${m.html || ''}\n${m.text || ''}`,
      })),
      loadMessage: async (msg) => {
        const res = await this.t.json(`${this.base}/api/parsed_mail/${msg.id}`, {
          headers: { Authorization: `Bearer ${inbox.token}` },
        });
        const d = res.data || {};
        return `${d.html || ''}\n${d.text || ''}`;
      },
    });
  }
}

// ── fixed code: for an operator-supplied inbox, still non-interactive ──

export class CodeProvider {
  constructor({ email = null, code = null } = {}) {
    this.name = 'code';
    this.email = email;
    this.code = String(code ?? '');
  }

  async createInbox() {
    if (!this.email || !this.email.includes('@')) throw new Error('provider=code requires --email');
    if (!/^\d{6}$/.test(this.code)) throw new Error('provider=code requires --code with a 6-digit OTP');
    return { address: this.email };
  }

  async waitForVerifyMail() {
    return { content: `Your Qwen verification code is ${this.code}`, subject: 'Fixed code', from: 'code', code: this.code };
  }
}

export function buildProvider(kind, opts = {}) {
  switch (String(kind || '').toLowerCase()) {
    case 'mailtm':
      return new MailTmProvider(opts);
    case 'tempmail':
      return new TempMailProvider(opts);
    case 'guerrilla':
      return new GuerrillaProvider(opts);
    case 'cfmail':
      return new CfMailProvider(opts);
    case 'code':
      return new CodeProvider(opts);
    default:
      throw new Error(`unknown provider "${kind}" (expected mailtm | tempmail | guerrilla | cfmail | code)`);
  }
}
