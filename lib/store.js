// Configuration and output storage for qwen-regger.
// Real accounts are kept outside the repository by default.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeProxy, normalizeProxyType } from './proxy.js';

export const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const envPath = (name) => (process.env[name] ? path.resolve(process.env[name]) : null);

export const CONFIG_FILE = envPath('QWEN_REGGER_CONFIG') || path.join(ROOT_DIR, 'config.json');

const APPDATA_DIR =
  process.env.APPDATA ||
  (process.platform === 'darwin'
    ? path.join(process.env.HOME || '', 'Library', 'Application Support')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config')));

export const APP_DATA_DIR = path.join(APPDATA_DIR, 'Qwen-Regger');

export const ACCOUNTS_FILE = envPath('QWEN_REGGER_ACCOUNTS') || path.join(APP_DATA_DIR, 'accounts.json');

export const DEFAULT_CONFIG = {
  headless: true,
  proxy: null,
  proxyType: null,
  proxyFile: null,
  proxyBypass: null,
  browser: null, // null = autodetect | chrome | msedge | chromium
  provider: 'tempmail', // mailtm | tempmail | guerrilla | cfmail | code
  code: null, // fixed OTP for provider=code (non-interactive)
  email: null, // explicit email for provider=code
  out: null,
  interval: 65,
  captchaTimeout: 300, // seconds
  emailTimeout: 180, // seconds
  autoAttempts: 10,
  captchaRounds: 2, // fresh browser sessions after a full failed round
  insecure: false,
  verbose: false,
};

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function normalizeConfig(input = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(input || {}) };
  cfg.browser = cfg.browser ? String(cfg.browser).toLowerCase() : null;
  cfg.provider = String(cfg.provider || 'tempmail').toLowerCase();
  cfg.proxyType = normalizeProxyType(cfg.proxyType);
  cfg.proxyFile = cfg.proxyFile ? String(cfg.proxyFile) : null;
  cfg.proxyBypass = cfg.proxyBypass ? String(cfg.proxyBypass) : null;
  cfg.proxy = normalizeProxy(cfg.proxy, cfg.proxyType);
  cfg.headless = cfg.headless !== false;
  cfg.insecure = !!cfg.insecure;
  cfg.verbose = !!cfg.verbose;
  return cfg;
}

export function loadConfig(file = CONFIG_FILE) {
  return normalizeConfig(readJson(file, {}) || {});
}
