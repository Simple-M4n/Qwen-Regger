# qwen-regger

[Русская версия](README.ru.md)

`qwen-regger` registers `chat.qwen.ai` accounts automatically. It is a
command-line tool only: no chat client, interactive shell, TUI or slash
commands. Every setting comes from `config.json` plus CLI flags.

Flow per account: temporary mailbox → Qwen email-OTP signup in a real browser
(Aliyun WAF slider solved automatically) → OTP from the mailbox → code submit →
access token + cookies saved outside the repository.

> **Note:** Qwen's current signup is email OTP. Older password-based scripts
> for this site target a deprecated form and no longer work.

## Requirements

- Node.js ≥ 20
- `npm install` (installs `playwright-core`)
- Google Chrome or Microsoft Edge — autodetected, or set `browser` in config
- No Python required

## Quick start

```bash
npm install
node qwen-regger.js --help
node qwen-regger.js --selftest          # network / mailbox / browser check
node qwen-regger.js --count 1           # register one account
node qwen-regger.js --provider code --email you@example.com --code 123456
```

Every CLI flag overrides `config.json` for that run only. To make a setting
permanent, edit `config.json`.

Output is quiet by default. Add `--verbose` or `"verbose": true` in config for
detailed solver, mail and browser diagnostics.

## config.json

| Field | Default | Meaning |
|---|---|---|
| `headless` | `true` | `true` = background browser, `false` = visible window |
| `proxy` | `null` | Proxy URL/object, or `null` for a direct connection |
| `proxyType` | `null` | Default type for a bare `host:port` proxy |
| `proxyFile` | `null` | File with a proxy list, rotated once per account |
| `proxyBypass` | `null` | Comma-separated hosts bypassing the proxy (browser only) |
| `browser` | `null` | `null` = autodetect, otherwise `chrome`, `msedge`, `chromium` |
| `provider` | `"tempmail"` | `mailtm`, `tempmail`, `guerrilla`, `cfmail`, `code` |
| `email` | `null` | Email for `provider=code` |
| `code` | `null` | Fixed 6-digit OTP for `provider=code` |
| `captchaRounds` | `2` | Fresh browser sessions after a full failed round |
| `autoAttempts` | `10` | Slider attempts per browser session |
| `captchaTimeout` | `300` | Max wait for WAF/OTP stage, seconds |
| `emailTimeout` | `180` | Wait for the OTP email, seconds |
| `interval` | `65` | Pause in seconds between registrations |
| `insecure` | `false` | Skip TLS certificate verification |
| `verbose` | `false` | Print detailed diagnostics |

Example:

```json
{
  "headless": true,
  "proxy": "socks5://user:pass@127.0.0.1:1080",
  "proxyType": null,
  "proxyFile": null,
  "proxyBypass": null,
  "browser": null,
  "provider": "tempmail",
  "captchaRounds": 2,
  "autoAttempts": 10,
  "interval": 65,
  "insecure": false,
  "verbose": false
}
```

## Provider `code`

For an already-owned mailbox where you know the OTP, set `"provider": "code"`
with `"email"` and `"code"` in config, or use `--email` / `--code`. The tool
still drives the real signup, waits for the code stage and submits the supplied
6-digit code; no mailbox polling or interactive prompt is involved.

## Proxy

Supported types: `http`, `https`, `socks4`, `socks4a`, `socks5`, `socks5h`.
The scheme in the URL selects the type; a bare `host:port` is treated as HTTP
unless `proxyType` (or `--proxy-type`) says otherwise.

```json
"proxy": "http://user:pass@proxy.example:8080"
"proxy": "socks5://user:pass@127.0.0.1:1080"
"proxy": { "type": "socks4", "host": "127.0.0.1", "port": 1080 }
```

With a bare address, set the type separately:

```json
"proxy": "127.0.0.1:1080",
"proxyType": "socks5"
```

The same via CLI:

```bash
node qwen-regger.js --proxy socks5://user:pass@127.0.0.1:1080 --count 1
node qwen-regger.js --proxy 127.0.0.1:1080 --proxy-type socks4 --count 1
node qwen-regger.js --proxy http://proxy.example:8080 --proxy-bypass localhost --count 1
node qwen-regger.js --proxy none --count 1   # disable the config proxy
```

Proxy credentials are applied to both the Node HTTP requests (mail/API) and
the browser. Keep real credentials out of the published repo: use an external
config file via `QWEN_REGGER_CONFIG` when storing a proxy password.

## Proxy rotation

Aliyun ties captcha risk state to the exit IP, so one address for a whole batch
makes later accounts much harder to pass. Put one proxy per line (or a JSON
array) in a local file and pass `--proxy-file proxies.txt` — each account gets
the next proxy. `#` comments and blank lines are ignored; bare `host:port`
entries use `--proxy-type`. The proxy file is never copied into the repository.

## CLI options

Run `node qwen-regger.js --help` for the full list. Main flags:

- `--count N`, `--provider K`, `--email ADDR`, `--code CODE`, `--interval SEC`
- `--auto-attempts N`, `--captcha-rounds N`, `--captcha-timeout SEC`
- `--email-timeout SEC`
- `--proxy URL`, `--proxy-type TYPE`, `--proxy-file LIST`, `--proxy-bypass LIST`
- `--browser CHANNEL`, `--headed`, `--insecure`
- `--out FILE`, `--selftest`, `--verbose`

## Accounts and privacy

Registered accounts are written outside the repository by default
(`%APPDATA%\Qwen-Regger\accounts.json` on Windows, equivalent config directory
elsewhere). Override with `--out` or `QWEN_REGGER_ACCOUNTS`. The committed
`accounts.json` is an empty `[]` template; no real accounts, JWTs, passwords or
logs belong in the repository. The solver also keeps a small
`slider-memory.json` next to `accounts.json`: it stores only a perceptual hash
of reused puzzle images and the gap that passed, never image bytes or account
data.

## Tests

```bash
npm test
node qwen-regger.js --selftest
```

The slider solver writes no debug files by default. Set `QWEN_SLIDER_DEBUG=1`
to save puzzle images and screenshots under `debug/` when investigating failures.
`QWEN_NO_STEALTH=1` disables the browser fingerprint overrides if you suspect
they are being flagged.

## Troubleshooting

`Aliyun WAF blocked this IP` means the slider was attempted but the challenge
was rejected. Aliyun binds risk state to the exit IP and browser session, so a
datacenter or shared address can fail no matter how accurate the drag is. Use a
clean residential proxy — ideally a `--proxy-file` list, since proxy rotation
is applied once per account. If even a clean IP fails, re-run with
`QWEN_SLIDER_DEBUG=1 --verbose` and inspect the saved puzzle images and the
candidate gaps printed by the solver.
