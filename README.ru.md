# qwen-regger

[English version](README.md)

`qwen-regger` автоматически регистрирует аккаунты `chat.qwen.ai`. Это только
CLI-утилита: никакого чата, интерактивной оболочки, TUI или команд вроде
`/config`. Вся настройка — через `config.json` и флаги CLI.

Один аккаунт: временная почта → регистрация на Qwen по email-коду в реальном
браузере (слайдер Aliyun решается автоматически) → код из почты → отправка кода →
токен доступа и куки сохраняются вне репозитория.

> **Важно:** текущая регистрация Qwen — по коду из email. Старые скрипты с
> паролем для этого сайта работают с устаревшей формой и больше не подходят.

## Требования

- Node.js ≥ 20
- `npm install` (устанавливает `playwright-core`)
- Google Chrome или Microsoft Edge — определяются автоматически, либо поле
  `browser` в конфиге
- Python не нужен

## Быстрый старт

```bash
npm install
node qwen-regger.js --help
node qwen-regger.js --selftest          # проверка сети, почты и браузера
node qwen-regger.js --count 1           # зарегистрировать один аккаунт
node qwen-regger.js --provider code --email you@example.com --code 123456
```

Каждый флаг CLI переопределяет `config.json` только для текущего запуска.
Чтобы сделать настройку постоянной, измените `config.json`. Числовые настройки
(`count`, `interval`, `autoAttempts`, `captchaRounds`, `captchaTimeout`,
`emailTimeout`) проверяются строго: `3abc`, `2.5`, `1e3` и отрицательные значения
отклоняются. Фиксированный `--code` должен содержать ровно шесть цифр; лишние
символы не отбрасываются.

По умолчанию выводятся основные этапы работы. Добавьте `--verbose` или
`"verbose": true` в конфиге для подробной диагностики слайдера, почты и браузера.

## config.json

| Поле | По умолчанию | Назначение |
|---|---|---|
| `headless` | `true` | `true` — фоновый браузер, `false` — видимое окно |
| `proxy` | `null` | URL/объект прокси либо `null` (прямое соединение) |
| `proxyType` | `null` | Тип по умолчанию для прокси вида `host:port` |
| `proxyFile` | `null` | Файл со списком прокси, смена на каждый аккаунт |
| `proxyBypass` | `null` | Хосты через запятую, минующие прокси (только браузер) |
| `browser` | `null` | `null` — автоопределение, иначе `chrome`, `msedge`, `chromium` |
| `mailBase` | `null` | URL экземпляра cfmail |
| `mailPass` | `null` | пароль сайта cfmail |
| `mailDomain` | `null` | домен адресов cfmail / guerrilla |
| `out` | `null` | файл аккаунтов (по умолчанию вне репозитория) |
| `provider` | `"tempmail"` | `mailtm`, `tempmail`, `guerrilla`, `cfmail`, `code` |
| `email` | `null` | Email для `provider=code` |
| `code` | `null` | Фиксированный 6-значный код для `provider=code` |
| `captchaRounds` | `2` | Новые сессии браузера после неудачного раунда |
| `autoAttempts` | `10` | Число попыток решения слайдера за сессию |
| `captchaTimeout` | `300` | Максимальное ожидание WAF/кода, секунды |
| `emailTimeout` | `180` | Ожидание письма с кодом, секунды |
| `interval` | `65` | Пауза в секундах между регистрациями |
| `insecure` | `false` | Не проверять TLS в Node и в браузере |
| `verbose` | `false` | Подробные диагностические сообщения |

Пример:

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

## Провайдер `code`

Если у вас уже есть почтовый ящик и известен код, установите `"provider": "code"`
вместе с `"email"` и `"code"` в конфиге или используйте `--email` / `--code`.
Утилита всё равно проходит реальную регистрацию, дожидается этапа ввода кода и
отправляет указанный 6-значный код; опрос почты и интерактивный ввод не нужны.

## Прокси

Поддерживаемые типы: `http`, `https`, `socks4`, `socks4a`, `socks5`, `socks5h`.
Тип выбирается схемой в URL; адрес вида `host:port` считается HTTP, если не
указан `proxyType` (или флаг `--proxy-type`). IPv6-адреса записываются в
квадратных скобках: `socks5://[::1]:1080` или `[::1]:1080` в файле прокси.

```json
"proxy": "http://user:pass@proxy.example:8080"
"proxy": "socks5://user:pass@127.0.0.1:1080"
"proxy": { "type": "socks4", "host": "127.0.0.1", "port": 1080 }
```

С адресом без схемы тип задаётся отдельно:

```json
"proxy": "127.0.0.1:1080",
"proxyType": "socks5"
```

То же через CLI:

```bash
node qwen-regger.js --proxy socks5://user:pass@127.0.0.1:1080 --count 1
node qwen-regger.js --proxy 127.0.0.1:1080 --proxy-type socks4 --count 1
node qwen-regger.js --proxy http://proxy.example:8080 --proxy-bypass localhost --count 1
node qwen-regger.js --proxy none --count 1   # отключить прокси из конфига
```

Прокси применяется и к сетевым запросам Node (почта/API), и к браузеру. Не
кладите реальные логины и пароли в публикуемый репозиторий: для конфига с
секретами используйте внешний файл через `QWEN_REGGER_CONFIG`.

## Флаги CLI

Полный список: `node qwen-regger.js --help`. Основные:

- `--count N`, `--provider K`, `--email ADDR`, `--code CODE`, `--interval SEC`
- `--auto-attempts N`, `--captcha-rounds N`, `--captcha-timeout SEC`
- `--email-timeout SEC`
- `--proxy URL`, `--proxy-type TYPE`, `--proxy-file LIST`, `--proxy-bypass LIST`
- `--mail-base URL`, `--mail-pass PASS`, `--mail-domain DOM`
- `--browser CHANNEL`, `--headed`, `--insecure`
- `--out FILE`, `--selftest`, `--verbose`

## Ротация прокси

Aliyun привязывает риск-состояние капчи к IP: один адрес на всю пачку делает
последующие аккаунты гораздо сложнее. Запишите прокси по одному на строку (или
JSON-массивом) в локальный файл и передайте `--proxy-file proxies.txt` — каждый
аккаунт получит следующий прокси. Пустые строки и комментарии `#` игнорируются,
для записей вида `host:port` используется `--proxy-type`. Сам файл в репозиторий
не добавляется.

## Аккаунты и приватность

По умолчанию аккаунты записываются вне репозитория
(`%APPDATA%\Qwen-Regger\accounts.json` в Windows, аналогичный каталог конфига
в других системах). Переопределить можно флагом `--out` или переменной
`QWEN_REGGER_ACCOUNTS`. Файл `accounts.json` в репозитории — пустой шаблон `[]`;
реальные аккаунты, JWT, пароли и логи в репозиторий не добавляются. Отдельно
решатель хранит небольшой `slider-memory.json` по фиксированному пути
`%APPDATA%\Qwen-Regger\slider-memory.json` в Windows (или
`~/.config/Qwen-Regger/slider-memory.json` в других системах). Флаг `--out` и
переменная `QWEN_REGGER_ACCOUNTS` не меняют этот путь, `XDG_CONFIG_HOME` не
используется. Там только перцептивный хеш повторяющихся изображений пазла и
сработавшая координата, без самих картинок и данных аккаунтов.

`--insecure` применяется к запросам Node, контексту Playwright и загрузке
изображений решателем. `captchaTimeout` проверяется при запуске, но ожидание
этапа кода в браузере сейчас ограничено 30 секундами; большие значения этот
период не увеличивают.

## Тесты

```bash
npm test            # юнит-проверки без браузера (node:test)
npm run test:unit   # тот же набор
npm run test:slider # дополнительная проверка анализатора (нужен браузер)
node qwen-regger.js --selftest   # сеть/почта/браузер (создаёт тестовый ящик)
```

Решатель слайдера по умолчанию не пишет отладочные файлы. Установите
`QWEN_SLIDER_DEBUG=1`, чтобы сохранить изображения пазла и скриншоты в `debug/`.
`QWEN_NO_STEALTH=1` отключает переопределения отпечатка браузера, если вы
подозреваете, что они вызывают блокировку.

## Устранение неполадок

`Aliyun WAF blocked this IP` означает, что слайдер был решён, но вызов
отклонён. Aliyun привязывает состояние риска к IP и сессии браузера, поэтому
датcenter- или общий адрес может не проходить проверку независимо от точности
движения. Используйте чистый жилой прокси — желательно список через
`--proxy-file`, так как прокси меняется на каждый аккаунт. Если и с чистым IP
проверка не проходит, запустите с `QWEN_SLIDER_DEBUG=1 --verbose` и изучите
сохранённые изображения пазла и варианты координат в выводе решателя.
