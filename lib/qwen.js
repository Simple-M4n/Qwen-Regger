// qwen.ai auth protocol helpers.
//
// Live signup flow (confirmed against chat.qwen.ai / auth.qwen.ai):
//   POST /api/v2/auths/otp/email/request
//        { identifier: email, accept_terms: true, language: 'en-US' }
//   POST /api/v2/auths/otp/email/verify
//        { identifier: email, code: '123456', name: null }
//
// The request endpoint is guarded by the same Aliyun WAF used by z.ai, so the
// normal registrar drives it through a real browser session. This client is
// used for connectivity checks and as a fallback for an already-solved session.

import { Transport } from './http.js';

export const BASE = 'https://chat.qwen.ai';
export const AUTH_BASE = 'https://auth.qwen.ai';
export const API = `${AUTH_BASE}/api/v2`;
export const AUTH_URL = `${BASE}/auth?mode=register`;

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export class QwenClient {
  constructor({ proxy = null, timeout = 30000, insecure = false, onRetry = null } = {}) {
    this.t = new Transport({ proxy, timeout, insecure, onRetry });
  }

  headers(extra = {}) {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: BASE,
      Referer: `${BASE}/auth`,
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
      ...extra,
    };
  }

  async post(path, payload, extraHeaders = {}) {
    return this.t.json(`${API}${path}`, {
      method: 'POST',
      headers: this.headers(extraHeaders),
      body: JSON.stringify(payload),
    });
  }

  requestOtp(email, language = 'en-US') {
    return this.post('/auths/otp/email/request', {
      identifier: email,
      accept_terms: true,
      language,
    });
  }

  verifyOtp(email, code, name = null) {
    return this.post('/auths/otp/email/verify', {
      identifier: email,
      code: String(code).replace(/\D/g, '').slice(0, 6),
      name,
    });
  }

  me(token) {
    return this.t.json(`${API}/auths/`, { headers: this.headers({ Authorization: `Bearer ${token}` }) });
  }

  config() {
    return this.t.json(`${BASE}/api/config`, { headers: this.headers() });
  }
}

// Qwen returns the signed-in user either directly or under `data`.
export function extractUser(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  if (!data || typeof data !== 'object') return null;
  return data.user && typeof data.user === 'object' ? data.user : data;
}

export function extractToken(payload) {
  const user = extractUser(payload);
  if (!user) return '';
  for (const key of ['access_token', 'token', 'accessToken', 'jwt']) {
    if (typeof user[key] === 'string' && user[key]) return user[key];
  }
  return '';
}

export function isWafHtml(text) {
  return /aliyun_waf_aa|aliyun_waf_bb|<title><\/title>|aliyunCaptcha-sliding-slider/i.test(String(text || ''));
}

export function requestSucceeded(payload) {
  return !!(payload && payload.success === true && payload.data && payload.data.status);
}

export function verifySucceeded(payload) {
  return !!(payload && payload.success === true && payload.data && extractToken(payload));
}

export function classifyFailure(payload) {
  const status = payload?.status ?? 0;
  const data = payload?.data;
  const text = typeof payload?.text === 'string' ? payload.text : JSON.stringify(data ?? '');
  const msg =
    data?.message ||
    data?.details ||
    data?.data?.message ||
    data?.data?.details ||
    text ||
    'no body';

  if (isWafHtml(text)) {
    return { kind: 'waf_block', message: 'Aliyun WAF blocked this IP — retry with a different proxy' };
  }
  if (/rate|too many|frequent|429/i.test(String(msg))) return { kind: 'rate_limit', message: String(msg) };
  if (/already|exist|registered|taken/i.test(String(msg))) return { kind: 'email_taken', message: String(msg) };
  if (/code|otp|verification|expired|invalid/i.test(String(msg))) return { kind: 'otp', message: String(msg) };
  if (status >= 500) return { kind: 'server', message: `HTTP ${status}: ${String(msg).slice(0, 200)}` };
  return { kind: 'rejected', message: String(msg).slice(0, 200) };
}
