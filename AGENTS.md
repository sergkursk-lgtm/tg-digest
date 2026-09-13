# AGENTS.md — конвенции tg-digest UI

Здесь только клиентская часть. Бэкенд, данные и секреты — в приватном
[`tg-digest-core`](https://github.com/sergkursk-lgtm/tg-digest-core); его конвенции
описаны в `AGENTS.md` того репозитория и здесь не повторяются.

## Стек

- HTML5, CSS3 на переменных, Vanilla JS. **ES-модули, без сборщиков.**
- **Никаких CDN и сторонних скриптов из сети.** Два исключения, оба лежат в
  репозитории и зафиксированы по хэшу в `frontend/vendor/README.md`:
  `tweetnacl.js` (XSalsa20-Poly1305, которого нет в WebCrypto, — нужен для записи
  секретов) и `telegram-web-app.js` (SDK Mini App: тема клиента и безопасные отступы).
- Node используется как раннер тестов (`node --test`) и для ручной проверки
  `tools/verify-seal.mjs`; в браузер Node не попадает.
- `package.json` в корне — только `"type": "module"` и скрипты. Никаких зависимостей
  в рантайме страницы: `node_modules` не нужен ни для сборки, ни для работы.

## Структура

```
frontend/
  index.html          — единственная страница и контейнеры экранов
  assets/theme.css    — токены тем и вёрстка
  assets/app.js       — точка входа: PIN-гейт, роутинг, дашборд, подвал
  assets/wizard.js    — мастер первого запуска
  assets/miniapp.js   — интеграция с Telegram Mini App (тема, отступы, ready)
  assets/telegram.js  — отправка в бота из браузера (зеркало backend/notifier.py)
  assets/state.js     — чтение ветки data и правила «что настроено» (чистые функции)
  assets/api.js       — клиент GitHub API (Contents, Actions, Secrets)
  assets/bytes.js     — base64 и UTF-8 для браузера и Node
  assets/crypto.js    — PIN → PBKDF2 → AES-GCM для хранения токена
  assets/seal.js      — libsodium sealed box поверх tweetnacl
  assets/blake2b.js   — BLAKE2b с настраиваемой длиной (нужен для nonce)
  assets/sanitize.js  — белый список HTML для дайджеста
  assets/dom.js       — безопасный DOM: никаких innerHTML для внешних данных
  assets/local.js     — localStorage: репозиторий и зашифрованный токен
  assets/tariff.js    — peak/off-peak (зеркало backend/pricing.py)
  vendor/             — вендорные библиотеки, см. vendor/README.md
tests/                — тесты на Node, вне frontend/, чтобы не публиковаться
tools/                — ручные проверки на живом репозитории
.github/workflows/pages.yml — тесты + публикация на Pages
```

## Правила

- **Тема** всегда пишется в `<html data-theme="light|dark">` инлайн-скриптом в `<head>`
  до первой отрисовки. CSS не должен содержать `prefers-color-scheme`:
  системную настройку разрешает JS, иначе появятся два конкурирующих источника правды.
- **Строки интерфейса — на русском.** Код, комментарии, имена — на английском.
- **Любой HTML из внешнего источника** (дайджест, заголовок канала, текст сообщения)
  вставляется в DOM только после санитизации. Сообщение из Telegram — недоверенный ввод.
  До Этапа 1 вставка через `innerHTML` для таких данных запрещена полностью.
- **Секреты** — только в памяти вкладки или зашифрованными в localStorage.
  Токен GitHub никогда не попадает в URL, в `console.log` и в сообщения об ошибках.
- Никакой аналитики, трекеров и внешних скриптов.
- Мобильная вёрстка обязательна: проверять на 375px.
- Тесты обязаны проходить без сети.

## Чего не делать

- Не добавлять React, Vue, Tailwind, сборщики и `node_modules` в рантайм страницы.
- Не дублировать бизнес-логику бэкенда. Два осознанных зеркала: `assets/tariff.js`
  (правила peak/off-peak) и `assets/telegram.js` (разбиение длинных сообщений), оба
  проверяются теми же инвариантами, что и Python-оригиналы.
- Не хранить в этом репозитории данные, секреты и содержимое дайджестов.
