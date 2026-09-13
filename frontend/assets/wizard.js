/**
 * The first-run wizard.
 *
 * Collects everything the project needs — GitHub token, Telegram app credentials, the
 * login code, the DeepSeek key, the bot token and the first channels — and puts it
 * where the backend expects it: GitHub Secrets where possible, the private data branch
 * otherwise.
 *
 * Two rules shape this file:
 *
 *   * a credential never travels through `workflow_dispatch` inputs, because those are
 *     recorded in the run and shown on the Actions page; the code and the 2FA password
 *     go into `data/login/request.json` and are wiped by the workflow as it consumes them;
 *   * nothing the user or Telegram supplies is ever parsed as HTML — everything goes
 *     through `dom.js`, which only ever sets textContent.
 */

import { GitHubError } from "./api.js";
import { createVault } from "./crypto.js";
import { clear, el, field, setStatus, statusLine } from "./dom.js";
import {
  DEEPSEEK_SECRET,
  PATHS,
  TELEGRAM_SECRETS,
  isNewerThan,
  loadSnapshot,
  optionalSteps,
  pendingSteps,
  setupSteps,
} from "./state.js";
import { DEFAULT_REPO, parseRepo, saveRepo, saveVault } from "./local.js";

const DEEPSEEK_API = "https://api.deepseek.com";
const TELEGRAM_API = "https://api.telegram.org";
const LOGIN_WORKFLOW = "telegram-login.yml";
const SETUP_WORKFLOW = "setup.yml";

/** Poll a function until it returns a truthy value or the deadline passes. */
async function pollUntil(probe, { intervalMs = 3000, timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result) {
      return result;
    }
    if (Date.now() > deadline) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Validate a DeepSeek key from the browser; the API sends permissive CORS headers. */
async function verifyDeepSeekKey(key) {
  const response = await fetch(`${DEEPSEEK_API}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-flash",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      thinking: { type: "disabled" },
    }),
  });
  if (response.status === 401) {
    throw new Error("DeepSeek отклонил ключ (401)");
  }
  if (response.status === 402) {
    throw new Error("на балансе DeepSeek нет средств (402)");
  }
  if (!response.ok) {
    throw new Error(`DeepSeek ответил HTTP ${response.status}`);
  }
  const body = await response.json();
  return { model: body.model, usage: body.usage ?? {} };
}

/** Call a Telegram Bot API method from the browser. */
async function callBot(method, token, payload = {}) {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({ ok: false, description: "нечитаемый ответ" }));
  if (!body.ok) {
    throw new Error(body.description ?? `HTTP ${response.status}`);
  }
  return body.result;
}

/** Merge the bot settings into data/settings.json without touching other values. */
export function mergeTelegramSettings(settings, telegram) {
  const base = settings ?? { schema: 1, values: {} };
  return {
    ...base,
    schema: base.schema ?? 1,
    values: {
      ...(base.values ?? {}),
      telegram: { ...(base.values?.telegram ?? {}), ...telegram },
    },
  };
}

/** Build a channel record with the next free id. */
export function buildChannel(existing, input, nowIso) {
  const nextId = existing.reduce((max, channel) => Math.max(max, Number(channel.id ?? 0)), 0) + 1;
  return {
    id: nextId,
    tg_id: input.tg_id,
    title: input.title,
    username: input.username || null,
    type: input.type,
    has_topics: Boolean(input.has_topics),
    summary_style_id: null,
    default_period_hours: Number(input.default_period_hours ?? 24),
    include_patterns: [],
    exclude_patterns: [],
    created_at: nowIso,
  };
}

/**
 * Create the wizard.
 *
 * @param {object} options
 * @param {HTMLElement} options.mount where the wizard renders
 * @param {object} options.context mutable holder; `context.client` is swapped once the
 *        token has been validated
 * @param {object} options.nacl the vendored tweetnacl namespace
 * @param {Function} options.refresh reload the snapshot and re-render
 * @param {Function} options.onComplete called when every required step is done
 * @param {Function} options.clientFactory builds a client for a token/repo pair that is
 *        not saved yet, which is exactly what the first step has to validate
 */
export function createWizard({ mount, context, nacl, refresh, onComplete, clientFactory }) {
  let snapshot = null;
  let secretNames = [];
  let activeStepId = null;

  /** Load fresh state from GitHub. */
  async function reload() {
    [snapshot, secretNames] = await Promise.all([loadSnapshot(context.client), context.client.listSecretNames()]);
    return snapshot;
  }

  /** Persist the login state file, keeping the fields the backend needs. */
  async function saveLoginState(patch) {
    // Read the file again rather than trusting the page snapshot: the workflow writes it
    // too, so a sha captured at render time is often already stale.
    const stored = await context.client.readJson(PATHS.loginState);
    const current = stored?.data ?? {};
    const payload = {
      schema: 1,
      updated_at: new Date().toISOString(),
      step: "idle",
      api_id: null,
      api_hash: "",
      phone: "",
      phone_code_hash: null,
      session: null,
      user_id: null,
      username: null,
      error: null,
      ...current,
      ...patch,
    };
    await context.client.writeJson(
      PATHS.loginState,
      payload,
      "chore(login): update state",
      stored?.sha ?? null,
    );
  }

  /** Write the one-shot request the login workflow consumes. */
  async function saveLoginRequest(patch) {
    const existing = await context.client.readJson(PATHS.loginRequest);
    const payload = {
      schema: 1,
      updated_at: new Date().toISOString(),
      step: "send_code",
      phone: "",
      code: "",
      password: "",
      ...patch,
    };
    await context.client.writeJson(
      PATHS.loginRequest,
      payload,
      `chore(login): request ${payload.step}`,
      existing?.sha,
    );
  }

  /** Try to write a secret; a permission failure is reported, not thrown. */
  async function tryPutSecret(name, value) {
    try {
      await context.client.putSecret(name, value);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }

  /** Render the step list plus the active step body. */
  function render() {
    const steps = setupSteps(snapshot, secretNames);
    const visible = steps.filter((step) => !step.hidden);
    const blocking = pendingSteps(steps);
    const optional = optionalSteps(steps);

    if (!activeStepId || !visible.some((step) => step.id === activeStepId && !step.done)) {
      activeStepId = blocking[0]?.id ?? null;
    }

    clear(mount);
    if (!activeStepId) {
      // Nothing required is left; optional steps stay reachable, and the application is
      // usable either way.
      mount.append(
        el("section", { class: "card" }, [
          el("h1", { text: "Всё готово" }),
          el("p", { class: "lede", text: "Можно запускать дайджесты." }),
          optional.length
            ? el("div", {}, [
                el("h2", { text: "Необязательно" }),
                el(
                  "ul",
                  { class: "list" },
                  optional.map((step) =>
                    el("li", { class: "list__item" }, [
                      el("div", {}, [
                        el("span", { class: "list__title", text: step.title }),
                        el("span", { class: "list__sub", text: ` ${step.hint}` }),
                      ]),
                      el("button", {
                        class: "button",
                        type: "button",
                        text: "Настроить",
                        on: {
                          click: () => {
                            activeStepId = step.id;
                            render();
                          },
                        },
                      }),
                    ]),
                  ),
                ),
              ])
            : null,
          el("button", {
            class: "button button--primary",
            type: "button",
            text: "Перейти к дашборду",
            on: { click: () => onComplete() },
          }),
        ]),
      );
      return;
    }

    mount.append(
      el("section", { class: "card" }, [
        el("h1", { text: "Настройка" }),
        el("p", {
          class: "lede",
          text: "Ключи сохраняются в GitHub Secrets; то, что туда не помещается, — в приватную ветку data.",
        }),
        renderChecklist(visible, activeStepId),
      ]),
    );

    const body = el("section", { class: "card card--step" });
    mount.append(body);
    STEPS[activeStepId](body);

    const active = visible.find((step) => step.id === activeStepId);
    if (active?.optional) {
      // Without this the user could open an optional step and have no way back, because
      // the dashboard is reached from the "done" card.
      body.append(
        el("button", {
          class: "button button--link",
          type: "button",
          text: "Пропустить — это необязательно",
          on: { click: skipOptional },
        }),
      );
    }
  }

  /** The checklist of setup steps. */
  function renderChecklist(visible, active) {
    return el(
      "ol",
      { class: "steps" },
      visible.map((step) =>
        el("li", { class: `steps__item${step.done ? " steps__item--done" : ""}${step.id === active ? " step--active" : ""}` }, [
          el("button", {
            class: "steps__button",
            type: "button",
            text: `${step.done ? "✓" : "•"} ${step.title}`,
            on: {
              click: () => {
                activeStepId = step.id;
                render();
              },
            },
          }),
          el("span", {
            class: "steps__hint",
            text: step.optional && !step.done ? `${step.hint} — необязательно` : step.hint,
          }),
        ]),
      ),
    );
  }

  /** Skip an optional step and, if nothing blocks, finish the wizard. */
  async function skipOptional() {
    activeStepId = null;
    await advance();
  }

  /** Move to the next pending step after a successful action. */
  async function advance() {
    await reload();
    activeStepId = null;
    render();
  }

  // -- steps ------------------------------------------------------------------

  const STEPS = {
    /** Step 1: the GitHub token and the PIN that encrypts it. */
    "github-token": (node) => {
      const status = statusLine();
      const repository = field({
        label: "Репозиторий",
        value: context.client
          ? `${context.client.owner}/${context.client.repo}`
          : DEFAULT_REPO,
        hint: "приватный репозиторий, где лежат данные",
      });
      const token = field({
        label: "GitHub-токен (fine-grained PAT)",
        type: "password",
        placeholder: "github_pat_…",
        hint: "нужны права Actions, Contents, Secrets (read/write) и Metadata (read)",
      });
      const pin = field({ label: "PIN", type: "password", maxlength: 12, hint: "защитит токен в этом браузере" });
      const pin2 = field({ label: "PIN ещё раз", type: "password", maxlength: 12 });

      node.append(
        el("h2", { text: "GitHub" }),
        el("p", { class: "lede", text: "Токен хранится только в этом браузере, зашифрованный PIN-ом." }),
        repository.field,
        token.field,
        pin.field,
        pin2.field,
        el("button", {
          class: "button button--primary",
          type: "button",
          text: "Проверить и сохранить",
          on: {
            click: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              try {
                if (pin.input.value.length < 4) {
                  throw new Error("PIN короче 4 символов");
                }
                if (pin.input.value !== pin2.input.value) {
                  throw new Error("PIN-ы не совпадают");
                }
                const target = parseRepo(repository.input.value);
                setStatus(status, "Проверяю токен…");
                const probe = clientFactory({
                  owner: target.owner,
                  repo: target.repo,
                  token: token.input.value.trim(),
                });
                const who = await probe.whoami();
                const access = await probe.assertRepositoryAccess();
                if (!access.canPush) {
                  setStatus(
                    status,
                    `Токен принят (${who.login}), но у него нет права Contents: write на ${access.fullName}.`,
                    "error",
                  );
                  return;
                }

                // Prove the token can write Secrets before the wizard depends on it:
                // finding out at step 5 would mean redoing the Telegram login.
                await probe.putSecret("_TG_DIGEST_PROBE", "permission-check");
                await probe.deleteSecret("_TG_DIGEST_PROBE");

                saveRepo(target.owner, target.repo);
                saveVault(await createVault(pin.input.value, token.input.value.trim()));
                setStatus(
                  status,
                  `Токен принят: ${who.login}. Права на запись и Secrets есть — открываю мастер.`,
                  "ok",
                );
                await onComplete({ client: probe, repo: target });
              } catch (error) {
                setStatus(status, error.message, "error");
              } finally {
                button.disabled = false;
              }
            },
          },
        }),
        status,
      );
    },

    /** Step 2: Telegram application credentials, then request a code. */
    "telegram-app": (node) => {
      const status = statusLine();
      const secretsHaveApp =
        secretNames.includes("TG_API_ID") && secretNames.includes("TG_API_HASH");
      const apiId = field({
        label: "api_id",
        value: snapshot.login?.api_id ?? "",
        hint: secretsHaveApp
          ? "уже сохранён в Secrets — можно оставить пустым"
          : "число с my.telegram.org",
      });
      const apiHash = field({
        label: "api_hash",
        value: snapshot.login?.api_hash ?? "",
        hint: secretsHaveApp ? "уже сохранён в Secrets" : "",
      });
      const phone = field({
        label: "Номер телефона",
        value: snapshot.login?.phone ?? "",
        placeholder: "+79001234567",
        hint: "номер аккаунта, чьи чаты будет читать приложение",
      });

      node.append(
        el("h2", { text: "Telegram" }),
        el("p", {
          class: "lede",
          text: "Создайте приложение на my.telegram.org → API development tools и возьмите api_id и api_hash.",
        }),
        apiId.field,
        apiHash.field,
        phone.field,
        el("button", {
          class: "button button--primary",
          type: "button",
          text: "Получить код в Telegram",
          on: {
            click: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              try {
                const appId = apiId.input.value.trim();
                const appHash = apiHash.input.value.trim();
                const phoneNumber = phone.input.value.trim();

                // The credentials may already be in Secrets from an earlier session; then
                // only the phone number is still needed to request a code.
                if (!secretsHaveApp && !/^\d+$/.test(appId)) {
                  throw new Error("api_id должен быть числом");
                }
                if (!secretsHaveApp && !appHash) {
                  throw new Error("api_hash пуст");
                }
                if (!phoneNumber) {
                  throw new Error("номер телефона пуст");
                }

                setStatus(status, "Сохраняю ключи приложения…");
                const results = [await tryPutSecret("TG_PHONE", phoneNumber)];
                if (appId) {
                  results.push(await tryPutSecret("TG_API_ID", appId));
                }
                if (appHash) {
                  results.push(await tryPutSecret("TG_API_HASH", appHash));
                }
                const failed = results.find((result) => !result.ok);

                const patch = {
                  step: "idle",
                  phone: phoneNumber,
                  session: null,
                  user_id: null,
                  username: null,
                  error: null,
                };
                // Never blank out credentials that are already stored or in Secrets.
                if (appId) {
                  patch.api_id = Number(appId);
                }
                if (appHash) {
                  patch.api_hash = appHash;
                }
                await saveLoginState(patch);

                setStatus(status, "Запускаю отправку кода…");
                const requestedAt = Date.now();
                await context.client.dispatch(LOGIN_WORKFLOW, { step: "send-code" });
                const sent = await pollUntil(async () => {
                  const data = (await context.client.readJson(PATHS.loginState))?.data;
                  // Ignore the previous attempt's outcome, which is still on disk.
                  if (!isNewerThan(data, requestedAt)) {
                    return null;
                  }
                  if (data.step === "failed") {
                    throw new Error(data.error ?? "Telegram отказал");
                  }
                  return data.step === "code_sent";
                });

                if (!sent) {
                  throw new Error("код не отправился за две минуты — посмотрите Actions → telegram-login");
                }
                if (failed) {
                  setStatus(
                    status,
                    "Код отправлен. Ключи приложения сохранены в приватной ветке, но не в Secrets: " +
                      failed.message,
                    "warn",
                  );
                } else {
                  setStatus(status, "Код отправлен в приложение Telegram.", "ok");
                }
                await advance();
              } catch (error) {
                setStatus(status, error.message, "error");
              } finally {
                button.disabled = false;
              }
            },
          },
        }),
        status,
      );
    },

    /** Step 3: submit the code (and the 2FA password when asked). */
    "telegram-code": (node) => {
      const status = statusLine(
        snapshot.login?.error ? `Прошлая попытка: ${snapshot.login.error}` : "",
        "warn",
      );
      const code = field({ label: "Код из Telegram", placeholder: "12345", maxlength: 8 });
      const password = field({
        label: "Пароль двухшаговой проверки",
        type: "password",
        hint: "заполните, только если он включён на аккаунте",
      });

      node.append(
        el("h2", { text: "Код из Telegram" }),
        el("p", { class: "lede", text: `Код отправлен на ${snapshot.login?.phone ?? "ваш номер"}.` }),
        code.field,
        password.field,
        el("button", {
          class: "button button--primary",
          type: "button",
          text: "Войти",
          on: {
            click: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              try {
                if (!code.input.value.trim()) {
                  throw new Error("введите код");
                }
                await saveLoginRequest({
                  step: "sign_in",
                  phone: snapshot.login?.phone ?? "",
                  code: code.input.value.trim(),
                  password: password.input.value,
                });
                setStatus(status, "Отправляю код в Telegram…");
                const submittedAt = Date.now();
                await context.client.dispatch(LOGIN_WORKFLOW, { step: "sign-in" });

                const finished = await pollUntil(async () => {
                  const data = (await context.client.readJson(PATHS.loginState))?.data;
                  if (!isNewerThan(data, submittedAt)) {
                    return null;
                  }
                  if (data.step === "authorized") {
                    return data;
                  }
                  // A wrong code leaves the state retryable but sets the reason, so the
                  // same code request can be used again.
                  if (data.step === "failed" || data.error) {
                    throw new Error(data.error ?? "вход не удался");
                  }
                  return null;
                });

                if (!finished) {
                  throw new Error("вход не завершился за две минуты — посмотрите Actions → telegram-login");
                }
                setStatus(
                  status,
                  `Вошли как ${finished.username ? `@${finished.username}` : `id ${finished.user_id}`}.`,
                  "ok",
                );
                await advance();
              } catch (error) {
                setStatus(status, error.message, "error");
              } finally {
                button.disabled = false;
              }
            },
          },
        }),
        status,
      );
    },

    /** Step 4: move the session string out of the branch and into Secrets. */
    "telegram-session": (node) => {
      const status = statusLine();
      const session = snapshot.login?.session ?? "";

      node.append(
        el("h2", { text: "Сессия Telegram" }),
        el("p", {
          class: "lede",
          text: "Сессия — это полный доступ к аккаунту. Сейчас она лежит в приватной ветке data; лучше перенести её в GitHub Secrets.",
        }),
        el("p", { class: "muted", text: `Длина строки сессии: ${session.length} символов.` }),
        el("button", {
          class: "button button--primary",
          type: "button",
          text: "Перенести в Secrets и удалить из ветки",
          on: {
            click: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              try {
                if (!session) {
                  throw new Error("в ветке нет сессии: войдите заново");
                }
                setStatus(status, "Записываю секрет…");
                await context.client.putSecret("TG_STRING_SESSION", session);
                setStatus(status, "Секрет записан, убираю копию из ветки…");
                await saveLoginState({ session: null });
                setStatus(status, "Готово: сессия только в Secrets.", "ok");
                await advance();
              } catch (error) {
                setStatus(
                  status,
                  `${error.message} Сессия останется в приватной ветке — дайджесты будут работать, но доступ к ней есть у любого, кто читает репозиторий.`,
                  "warn",
                );
              } finally {
                button.disabled = false;
              }
            },
          },
        }),
        el("button", {
          class: "button",
          type: "button",
          text: "Оставить как есть",
          on: {
            click: async () => {
              await advance();
            },
          },
        }),
        status,
      );
    },

    /** Step 5: the DeepSeek key, validated before it is stored. */
    deepseek: (node) => {
      const status = statusLine();
      const key = field({
        label: "Ключ DeepSeek",
        type: "password",
        placeholder: "sk-…",
        hint: "platform.deepseek.com → API keys",
      });

      node.append(
        el("h2", { text: "DeepSeek" }),
        el("p", { class: "lede", text: "Единственная модель — deepseek-flash, thinking выключен." }),
        key.field,
        el("button", {
          class: "button button--primary",
          type: "button",
          text: "Проверить и сохранить",
          on: {
            click: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              try {
                const value = key.input.value.trim();
                if (!value) {
                  throw new Error("ключ пуст");
                }
                setStatus(status, "Проверяю ключ в DeepSeek…");
                const probe = await verifyDeepSeekKey(value);
                setStatus(status, `Ключ рабочий, модель ${probe.model}. Записываю секрет…`);
                await context.client.putSecret(DEEPSEEK_SECRET, value);
                setStatus(status, "Готово.", "ok");
                await advance();
              } catch (error) {
                setStatus(status, error.message, "error");
              } finally {
                button.disabled = false;
              }
            },
          },
        }),
        status,
      );
    },

    /** Step 6: bot token and chat id, both verified by sending a test message. */
    bot: (node) => {
      const status = statusLine();
      const token = field({
        label: "Токен бота",
        type: "password",
        value: snapshot.settings?.values?.telegram?.bot_token ?? "",
        placeholder: "123456:ABC-DEF…",
        hint: "получите у @BotFather",
      });
      const chatId = field({
        label: "chat_id",
        value: snapshot.settings?.values?.telegram?.chat_id ?? "",
        hint: "нажмите «Узнать chat_id» после того, как напишете боту",
      });

      node.append(
        el("h2", { text: "Доставка в Telegram" }),
        el("p", { class: "lede", text: "Дайджест будет приходить вам в личку от бота." }),
        token.field,
        chatId.field,
        el("div", { class: "row" }, [
          el("button", {
            class: "button",
            type: "button",
            text: "Узнать chat_id",
            on: {
              click: async () => {
                try {
                  setStatus(status, "Смотрю, кому бот писал…");
                  const updates = await callBot("getUpdates", token.input.value.trim(), {});
                  const ids = [
                    ...new Set(
                      updates
                        .map((update) => update.message?.chat?.id ?? update.my_chat_member?.chat?.id)
                        .filter((id) => id !== undefined),
                    ),
                  ];
                  if (ids.length === 0) {
                    setStatus(status, "Ничего не нашлось: напишите боту любое сообщение и повторите.", "warn");
                  } else {
                    chatId.input.value = String(ids[0]);
                    setStatus(status, `Найден chat_id: ${ids.join(", ")}`, "ok");
                  }
                } catch (error) {
                  setStatus(status, error.message, "error");
                }
              },
            },
          }),
        ]),
        el("button", {
          class: "button button--primary",
          type: "button",
          text: "Проверить и сохранить",
          on: {
            click: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              try {
                const botToken = token.input.value.trim();
                const target = chatId.input.value.trim();
                if (!botToken || !target) {
                  throw new Error("заполните токен и chat_id");
                }
                setStatus(status, "Проверяю бота…");
                const me = await callBot("getMe", botToken, {});
                setStatus(status, `Бот @${me.username}. Отправляю тестовое сообщение…`);
                await callBot("sendMessage", botToken, {
                  chat_id: target,
                  text: "tg-digest: проверка связи. Всё настроено.",
                  link_preview_options: { is_disabled: true },
                });

                const merged = mergeTelegramSettings(snapshot.settings, {
                  bot_token: botToken,
                  chat_id: target,
                });
                await context.client.writeJson(
                  PATHS.settings,
                  merged,
                  "feat(settings): configure bot delivery",
                  snapshot.settingsSha,
                );
                setStatus(status, "Сообщение отправлено, настройки сохранены.", "ok");
                await advance();
              } catch (error) {
                setStatus(status, error.message, "error");
              } finally {
                button.disabled = false;
              }
            },
          },
        }),
        status,
      );
    },

    /** Step 7: at least one channel to summarise. */
    channels: (node) => {
      const status = statusLine();
      const title = field({ label: "Название", placeholder: "Как называть в интерфейсе" });
      const reference = field({
        label: "Username или id",
        placeholder: "@channel или -1001234567890",
        hint: "для приватных каналов — числовой id",
      });
      const type = el("select", { class: "input" }, [
        el("option", { value: "channel", text: "Канал" }),
        el("option", { value: "group", text: "Группа" }),
        el("option", { value: "forum", text: "Форум с топиками" }),
        el("option", { value: "user", text: "Личный чат" }),
      ]);
      const period = field({ label: "Период по умолчанию, часов", type: "number", value: "24" });

      node.append(
        el("h2", { text: "Каналы" }),
        el("p", { class: "lede", text: "Добавьте хотя бы один источник. Остальные можно добавить позже." }),
        title.field,
        reference.field,
        el("label", { class: "field" }, [el("span", { class: "field__label", text: "Тип" }), type]),
        period.field,
        el("button", {
          class: "button button--primary",
          type: "button",
          text: "Добавить канал",
          on: {
            click: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              try {
                const raw = reference.input.value.trim();
                if (!title.input.value.trim() || !raw) {
                  throw new Error("заполните название и ссылку");
                }
                const username = raw.startsWith("@") ? raw.slice(1) : "";
                const numeric = raw.replace(/^@/, "");
                const tgId = /^-?\d+$/.test(numeric) ? numeric : null;
                if (!username && !tgId) {
                  throw new Error("укажите @username или числовой id");
                }

                const record = buildChannel(
                  snapshot.channels,
                  {
                    title: title.input.value.trim(),
                    username,
                    tg_id: tgId ?? numeric,
                    type,
                    has_topics: type.value === "forum",
                    default_period_hours: Number(period.input.value || 24),
                  },
                  new Date().toISOString(),
                );
                const payload = {
                  schema: 1,
                  updated_at: new Date().toISOString(),
                  items: [...snapshot.channels, record],
                };
                setStatus(status, "Сохраняю…");
                await context.client.writeJson(PATHS.channels, payload, `feat(channels): add ${record.title}`, snapshot.channelsSha);
                setStatus(status, `Канал «${record.title}» добавлен.`, "ok");
                await advance();
              } catch (error) {
                setStatus(status, error.message, "error");
              } finally {
                button.disabled = false;
              }
            },
          },
        }),
        status,
      );
    },
  };

  /** Build a throwaway client for repository coordinates that are not saved yet. */
  function createClientFor(target, token) {
    return clientFactory({ owner: target.owner, repo: target.repo, token });
  }

  return {
    async start() {
      await reload();
      render();
    },
    async refresh() {
      await reload();
      render();
    },
    render,
    /** Render just the token step, used before any client exists. */
    renderTokenStep(node) {
      STEPS["github-token"](node);
    },
  };
}

export { DEFAULT_REPO, TELEGRAM_SECRETS };
