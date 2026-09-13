/**
 * Settings: status, credentials, delivery, budget, limits, and the two sections that used
 * to be tabs of their own — templates and statistics.
 *
 * This is where everything that is *not* the everyday loop lives. The first run only asks
 * for the GitHub token and a PIN; every other credential is entered here, one section at a
 * time, because a wall of six forms at first launch is what made the old wizard unpleasant.
 *
 * The DeepSeek key and the Telegram secrets live in GitHub Secrets, which a page cannot
 * read back: only their *names* are readable. So each section shows whether the secret
 * exists and lets the user replace it, rather than pretending to display it.
 */

import {
  SETUP_WORKFLOW,
  callBot,
  discoverChatIds,
  mergeTelegramSettings,
  runWorkflow,
  verifyDeepSeekKey,
} from "./backend.js";
import { clear, el, field, setStatus, statusLine } from "./dom.js";
import { DEEPSEEK_SECRET, PATHS, formatDate, formatMoment, formatTokens, formatUsd, usageByDay, usageSummary } from "./state.js";
import {
  actionButton,
  button,
  card,
  confirmSheet,
  haptic,
  listRow,
  screen,
  stepList,
} from "./ui.js";

/** Write data/settings.json, always against a freshly read sha. */
async function saveSettings(ctx, payload, message) {
  const stored = await ctx.client.readJson(PATHS.settings);
  await ctx.client.writeJson(PATHS.settings, payload, message, stored?.sha ?? null);
}

/** A labelled value row. */
function kv(key, value, kind = "") {
  return el("div", { class: "kv" }, [
    el("span", { class: "kv__k", text: key }),
    el("span", { class: `kv__v${kind ? ` kv__v--${kind}` : ""}`, text: value }),
  ]);
}

/** The setup check: when it last ran and what it found. */
function statusSection(ctx) {
  const record = ctx.snapshot.setupRun;
  const status = statusLine();
  const body = el("div", { class: "stack" });

  const render = (data) => {
    clear(body);
    if (!data?.steps?.length) {
      body.append(
        el("p", { class: "small muted", text: "Проверка ещё не запускалась." }),
      );
      return;
    }
    body.append(
      kv(
        "Когда",
        formatMoment(data.finished_at ?? data.updated_at),
        data.status === "ok" ? "ok" : "error",
      ),
    );
    body.append(
      stepList(
        data.steps.map((step) => ({
          label: step.name,
          detail: step.detail ?? undefined,
          status:
            step.status === "ok"
              ? "ok"
              : step.status === "failed"
                ? "failed"
                : step.status === "running"
                  ? "running"
                  : "pending",
        })),
      ),
    );
  };

  const run = actionButton({
    label: "Проверить настройки",
    icon: "refresh",
    variant: "primary",
    busyLabel: "Проверяю…",
    action: async () => {
      try {
        setStatus(status, "Запускаю проверку в Actions…");
        const { started, record: fresh } = await runWorkflow({
          client: ctx.client,
          workflow: SETUP_WORKFLOW,
          inputs: {},
          timeoutMs: 10 * 60_000,
        });
        if (!started) {
          setStatus(status, "Запуск не появился в Actions за две минуты.", "warn");
          return;
        }
        if (!fresh) {
          setStatus(status, "Проверка не завершилась за десять минут.", "warn");
          return;
        }
        ctx.snapshot.setupRun = fresh;
        render(fresh);
        setStatus(
          status,
          fresh.status === "ok" ? "Всё в порядке." : "Проверка нашла проблемы — подробности выше.",
          fresh.status === "ok" ? "ok" : "error",
        );
      } catch (error) {
        setStatus(status, error.message, "error");
      }
    },
  });

  render(record);
  return card({
    title: "Статус",
    children: [body, run, status],
  });
}

/** Telegram account: who is logged in, and how to log in again. */
function telegramSection(ctx) {
  const login = ctx.snapshot.login ?? {};
  const hasSessionSecret = ctx.hasSecret("TG_STRING_SESSION");
  const sessionReady = login.step === "authorized" || hasSessionSecret;

  const sessionValue = hasSessionSecret
    ? "в GitHub Secrets"
    : login.session
      ? "в приватной ветке data"
      : "нет";

  return card({
    title: "Аккаунт Telegram",
    children: [
      kv("Сессия", sessionValue, sessionReady ? (hasSessionSecret ? "ok" : "warn") : "error"),
      kv("Номер", login.phone || "не указан"),
      kv("Аккаунт", login.username ? `@${login.username}` : login.user_id ? `id ${login.user_id}` : "—"),
      el("p", {
        class: "small muted",
        text: sessionReady
          ? "Сессия даёт полный доступ к аккаунту, поэтому её место — в Secrets."
          : "Без сессии дайджесты не соберутся: приложению нечем читать каналы.",
      }),
      button({
        label: sessionReady ? "Войти заново" : "Войти в Telegram",
        variant: sessionReady ? "ghost" : "primary",
        icon: "key",
        block: true,
        onClick: () => ctx.navigate("telegram-login"),
      }),
    ],
  });
}

/** DeepSeek key: only its presence is knowable, so it is replaceable rather than shown. */
function deepseekSection(ctx) {
  const stored = ctx.hasSecret(DEEPSEEK_SECRET);
  const status = statusLine();
  const key = field({
    label: stored ? "Новый ключ DeepSeek" : "Ключ DeepSeek",
    type: "password",
    placeholder: "sk-…",
    hint: "platform.deepseek.com → API keys",
  });

  const save = actionButton({
    label: stored ? "Заменить ключ" : "Проверить и сохранить",
    variant: "primary",
    busyLabel: "Проверяю…",
    action: async () => {
      const value = key.input.value.trim();
      if (!value) {
        setStatus(status, "Ключ пуст.", "error");
        return;
      }
      try {
        setStatus(status, "Спрашиваю DeepSeek…");
        const probe = await verifyDeepSeekKey(value);
        await ctx.client.putSecret(DEEPSEEK_SECRET, value);
        key.input.value = "";
        setStatus(status, `Ключ рабочий, модель ${probe.model}. Сохранён в Secrets.`, "ok");
        await ctx.refresh({ silent: true });
      } catch (error) {
        setStatus(status, error.message, "error");
      }
    },
  });

  return card({
    title: "DeepSeek",
    children: [
      kv("Ключ", stored ? "сохранён в Secrets" : "не задан", stored ? "ok" : "error"),
      kv("Модель", "deepseek-flash · thinking выключен"),
      ctx.secretsReadable
        ? null
        : el("p", {
            class: "small muted",
            text: "Токен не может читать список Secrets, поэтому наличие ключа берётся из последней проверки. Нажмите «Проверить настройки», чтобы обновить его.",
          }),
      key.field,
      save,
      status,
    ],
  });
}

/**
 * The bot as the *entrance* to the app, not as a delivery channel.
 *
 * Nothing is ever sent to Telegram: digests live in the data branch and are read here. What
 * the bot token is still good for is putting the "Дайджесты" button next to the message box,
 * which is how the app is opened on a phone.
 */
function telegramAppSection(ctx) {
  const telegram = ctx.snapshot.settings?.values?.telegram ?? {};
  const status = statusLine();
  const token = field({
    label: "Токен бота",
    type: "password",
    value: telegram.bot_token ?? "",
    placeholder: "123456:ABC-DEF…",
    hint: "получите у @BotFather",
  });
  const chatId = field({
    label: "chat_id",
    value: telegram.chat_id ?? "",
    hint: "напишите боту любое сообщение и нажмите «Узнать chat_id»",
  });

  const discover = button({
    label: "Узнать chat_id",
    onClick: async (event) => {
      const node = event.currentTarget;
      node.disabled = true;
      try {
        setStatus(status, "Смотрю, кому бот писал…");
        const ids = await discoverChatIds(token.input.value.trim());
        if (!ids.length) {
          setStatus(status, "Ничего не нашлось: напишите боту сообщение и повторите.", "warn");
        } else {
          chatId.input.value = ids[0];
          setStatus(status, `Найден chat_id: ${ids.join(", ")}`, "ok");
        }
      } catch (error) {
        setStatus(status, error.message, "error");
      } finally {
        node.disabled = false;
      }
    },
  });

  const save = actionButton({
    label: "Проверить и сохранить",
    variant: "primary",
    busyLabel: "Проверяю…",
    action: async () => {
      const botToken = token.input.value.trim();
      const chat = chatId.input.value.trim();
      if (!botToken || !chat) {
        setStatus(status, "Заполните токен и chat_id.", "error");
        return;
      }
      try {
        setStatus(status, "Проверяю бота…");
        // getMe only: nothing is sent to Telegram. Sending a test message would be a
        // delivery, and there is no delivery any more.
        const me = await callBot("getMe", botToken, {});
        const merged = mergeTelegramSettings(ctx.snapshot.settings, {
          bot_token: botToken,
          chat_id: chat,
        });
        await saveSettings(ctx, merged, "feat(settings): configure the Telegram app button");
        setStatus(status, `Бот @${me.username} отвечает. Настройки сохранены.`, "ok");
        await ctx.refresh({ silent: true });
      } catch (error) {
        setStatus(status, error.message, "error");
      }
    },
  });

  const showButton = actionButton({
    label: "Показать кнопку в боте",
    icon: "send",
    busyLabel: "Настраиваю…",
    action: async () => {
      const botToken = token.input.value.trim();
      const chat = chatId.input.value.trim();
      if (!botToken || !chat) {
        setStatus(status, "Сначала заполните токен и chat_id.", "error");
        return;
      }
      try {
        // The app's own address, so the button points wherever this copy is published.
        const url = `${location.origin}${location.pathname}`;
        setStatus(status, "Ставлю кнопку…");
        await callBot("setChatMenuButton", botToken, {
          chat_id: chat,
          menu_button: { type: "web_app", text: "Дайджесты", web_app: { url } },
        });
        setStatus(status, "Готово: кнопка «Дайджесты» появится у бота рядом с полем ввода.", "ok");
      } catch (error) {
        setStatus(status, error.message, "error");
      }
    },
  });

  return card({
    title: "Приложение в Telegram",
    subtitle: "Дайджесты остаются здесь. Бот нужен как вход — кнопка открывает это приложение.",
    children: [token.field, chatId.field, discover, save, showButton, status],
  });
}

/** The theme chooser. Client-side only: the choice belongs to this browser. */
function appearanceSection(ctx, { onThemeChange, currentTheme }) {
  const chips = el("div", { class: "chips" });
  const options = [
    { id: "system", label: "Как в системе" },
    { id: "light", label: "Светлая" },
    { id: "dark", label: "Тёмная" },
  ];

  const nodes = [];
  const paint = () => {
    for (const entry of nodes) {
      entry.node.classList.toggle("chip--on", entry.id === currentTheme());
    }
  };
  for (const option of options) {
    const node = el("button", {
      class: "chip",
      type: "button",
      text: option.label,
      on: {
        click: () => {
          haptic("select");
          onThemeChange(option.id);
          paint();
        },
      },
    });
    nodes.push({ node, id: option.id });
    chips.append(node);
  }
  paint();

  return card({
    title: "Оформление",
    children: [
      chips,
      el("p", { class: "small muted", text: "Тема хранится только в этом браузере." }),
    ],
  });
}

/** Presets and templates, collapsed: useful, but not part of the everyday loop. */
function templatesAccordion(ctx) {
  const presets = ctx.snapshot.presets ?? [];
  const templates = ctx.snapshot.templates ?? [];

  const body = el("div", { class: "accordion__body" }, [
    el("h3", { class: "small muted", text: "Стили" }),
    presets.length
      ? el(
          "ul",
          { class: "list" },
          presets.map((preset) =>
            el("li", {}, [
              listRow({
                title: preset.name,
                sub: preset.user_prompt_style || "без дополнительных указаний",
                meta: preset.is_default ? "по умолчанию" : null,
              }),
            ]),
          ),
        )
      : el("p", { class: "small muted", text: "Стили не заданы." }),
    el("h3", { class: "small muted section", text: "Шаблоны вёрстки" }),
    templates.length
      ? el(
          "ul",
          { class: "list" },
          templates.map((template) =>
            el("li", {}, [
              listRow({
                title: template.name,
                sub: `${template.grouping} · разделы: ${(template.sections ?? []).join(", ")}`,
                meta: template.is_default ? "по умолчанию" : null,
              }),
            ]),
          ),
        )
      : el("p", { class: "small muted", text: "Шаблонов нет — применяется стандартный." }),
  ]);

  return el("details", { class: "accordion" }, [
    el("summary", { text: "Шаблоны и стили" }),
    body,
  ]);
}

/** This month's spending, collapsed. */
function statisticsAccordion(ctx) {
  const summary = usageSummary(ctx.snapshot.usage, ctx.snapshot.settings);
  const days = usageByDay(ctx.snapshot.usage);

  const table = el("div", { class: "table-wrap" }, [
    el("table", { class: "table" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "День" }),
          el("th", { text: "Дайджестов" }),
          el("th", { text: "Вопросов" }),
          el("th", { text: "Токенов" }),
          el("th", { text: "$" }),
        ]),
      ]),
      el(
        "tbody",
        {},
        days.map((day) =>
          el("tr", {}, [
            el("td", { text: formatDate(day.date) }),
            el("td", { text: String(day.digests) }),
            el("td", { text: String(day.questions) }),
            el("td", { text: formatTokens(day.tokensIn + day.tokensOut) }),
            el("td", { text: formatUsd(day.costUsd) }),
          ]),
        ),
      ),
    ]),
  ]);

  const body = el("div", { class: "accordion__body" }, [
    kv("Месяц", ctx.snapshot.month ?? "—"),
    kv("Дайджестов", String(summary.digests)),
    summary.questions ? kv("Вопросов к ИИ", String(summary.questions)) : null,
    kv("Токенов на вход", formatTokens(summary.tokensIn)),
    kv("Токенов на выход", formatTokens(summary.tokensOut)),
    kv("Из них из кэша", formatTokens(summary.cacheHitTokens)),
    kv("Потрачено", `${formatUsd(summary.costUsd)} из ${formatUsd(summary.limitUsd)}`),
    days.length
      ? table
      : el("p", { class: "small muted", text: "В этом месяце ещё ничего не тратилось." }),
  ]);

  return el("details", { class: "accordion" }, [
    el("summary", { text: "Статистика за месяц" }),
    body,
  ]);
}

// -- the screen ---------------------------------------------------------------

/**
 * The settings screen.
 *
 * @param {object} ctx screen context from app.js, plus `secretNames`, `currentTheme` and
 *        `setTheme`
 */
export function createSettingsScreen(ctx) {

  const forget = button({
    label: "Забыть токен GitHub",
    variant: "danger",
    icon: "trash",
    block: true,
    onClick: async () => {
      const confirmed = await confirmSheet({
        title: "Забыть токен?",
        message:
          "Токен и PIN будут удалены из этого браузера. Данные в репозитории останутся, но войти снова можно будет только с токеном.",
        confirmLabel: "Удалить",
        danger: true,
      });
      if (confirmed) {
        ctx.onForgetToken();
      }
    },
  });

  const node = screen([
    el("p", {
      class: "small muted",
      text: `Репозиторий: ${ctx.client.owner}/${ctx.client.repo}`,
    }),
    el("div", { class: "stack stack--loose" }, [
      statusSection(ctx),
      telegramSection(ctx),
      deepseekSection(ctx),
      telegramAppSection(ctx),
      appearanceSection(ctx, {
        currentTheme: ctx.currentTheme,
        onThemeChange: ctx.setTheme,
      }),
      templatesAccordion(ctx),
      statisticsAccordion(ctx),
      card({ title: "Опасное", children: [forget] }),
    ]),
  ]);

  return { title: "Настройки", node };
}

// -- logging in again ---------------------------------------------------------

/**
 * The interactive Telegram login, as its own pushed screen.
 *
 * Telegram's own flow is inherently stepwise — ask for a code, then type it, then possibly
 * type a 2FA password — and the `telegram-login.yml` workflow mirrors that. The screen
 * resumes whatever step the stored state is on, so closing the app in the middle is safe.
 *
 * @param {object} ctx
 */
export function createTelegramLoginScreen(ctx) {
  const bridge = ctx.loginBridge;
  const node = screen([]);
  let step = "app";
  let status = null;

  /** Decide where to start from the stored state. */
  function initialStep() {
    const login = ctx.snapshot.login ?? {};
    if (login.step === "authorized" && !ctx.hasSecret("TG_STRING_SESSION")) {
      return "session";
    }
    if (login.step === "code_sent") {
      return "code";
    }
    return "app";
  }

  /** api_id / api_hash / phone → request a code. */
  function renderAppStep() {
    status = statusLine(ctx.snapshot.login?.error ?? "", ctx.snapshot.login?.error ? "warn" : "info");
    const secretsHaveApp = ctx.hasSecret("TG_API_ID") && ctx.hasSecret("TG_API_HASH");

    const apiId = field({
      label: "api_id",
      value: ctx.snapshot.login?.api_id ?? "",
      hint: secretsHaveApp ? "уже сохранён в Secrets — можно оставить пустым" : "число с my.telegram.org",
    });
    const apiHash = field({
      label: "api_hash",
      value: ctx.snapshot.login?.api_hash ?? "",
      hint: secretsHaveApp ? "уже сохранён в Secrets" : "",
    });
    const phone = field({
      label: "Номер телефона",
      value: ctx.snapshot.login?.phone ?? "",
      placeholder: "+79001234567",
      hint: "номер аккаунта, чьи чаты читает приложение",
    });

    const submit = actionButton({
      label: "Получить код в Telegram",
      variant: "primary",
      block: true,
      busyLabel: "Прошу код…",
      action: async () => {
        const appId = apiId.input.value.trim();
        const appHash = apiHash.input.value.trim();
        const phoneNumber = phone.input.value.trim();
        try {
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
          const { secretFailure } = await bridge.requestCode({
            apiId: appId,
            apiHash: appHash,
            phone: phoneNumber,
          });
          if (secretFailure) {
            setStatus(
              status,
              `Код отправлен. Ключи сохранены в приватной ветке, но не в Secrets (${secretFailure.name}): ${secretFailure.message}`,
              "warn",
            );
          } else {
            setStatus(status, "Код отправлен в приложение Telegram.", "ok");
          }
          await ctx.refresh({ silent: true });
          step = "code";
          render();
        } catch (error) {
          setStatus(status, error.message, "error");
        }
      },
    });

    clear(node);
    node.append(
      el("h1", { text: "Вход в Telegram" }),
      el("p", {
        class: "small muted",
        text: "Создайте приложение на my.telegram.org → API development tools и возьмите api_id и api_hash. Код придёт в приложение Telegram, не по SMS.",
      }),
      card({
        title: "Ключи приложения",
        children: [apiId.field, apiHash.field, phone.field],
      }),
      submit,
      status,
    );
  }

  /** The code, and the 2FA password when the account has one. */
  function renderCodeStep() {
    const login = ctx.snapshot.login ?? {};
    status = statusLine(login.error ? `Прошлая попытка: ${login.error}` : "", login.error ? "warn" : "info");
    const code = field({ label: "Код из Telegram", placeholder: "12345", maxlength: "8" });
    const password = field({
      label: "Пароль двухшаговой проверки",
      type: "password",
      hint: "заполните, только если он включён на аккаунте",
    });

    const submit = actionButton({
      label: "Войти",
      variant: "primary",
      block: true,
      busyLabel: "Вхожу…",
      action: async () => {
        const value = code.input.value.trim();
        try {
          if (!value) {
            throw new Error("введите код");
          }
          setStatus(status, "Отправляю код…");
          const state = await bridge.submitCode({
            phone: login.phone ?? "",
            code: value,
            password: password.input.value,
          });
          setStatus(
            status,
            `Вошли как ${state.username ? `@${state.username}` : `id ${state.user_id}`}.`,
            "ok",
          );
          await ctx.refresh({ silent: true });
          step = "session";
          render();
        } catch (error) {
          setStatus(status, error.message, "error");
        }
      },
    });

    clear(node);
    node.append(
      el("h1", { text: "Код из Telegram" }),
      el("p", { class: "small muted", text: `Код отправлен на ${login.phone ?? "ваш номер"}.` }),
      card({ title: "Код", children: [code.field, password.field] }),
      submit,
      status,
      button({
        label: "Запросить код заново",
        variant: "quiet",
        block: true,
        onClick: () => {
          step = "app";
          render();
        },
      }),
    );
  }

  /** Move the session out of the branch and into Secrets. */
  function renderSessionStep() {
    const session = ctx.snapshot.login?.session ?? "";
    status = statusLine();
    const inSecrets = ctx.hasSecret("TG_STRING_SESSION");

    clear(node);
    node.append(
      el("h1", { text: inSecrets ? "Сессия в Secrets" : "Сессия Telegram" }),
      el("p", {
        class: "small muted",
        text: inSecrets
          ? "Готово: строка сессии лежит в GitHub Secrets и больше не хранится в ветке."
          : "Сессия — это полный доступ к аккаунту. Сейчас она лежит в приватной ветке data; перенесите её в Secrets, чтобы доступ к ней был только у Actions.",
      }),
      el("p", { class: "small muted", text: `Длина строки: ${session.length} символов.` }),
      inSecrets
        ? null
        : actionButton({
            label: "Перенести в Secrets",
            variant: "primary",
            block: true,
            busyLabel: "Записываю…",
            action: async () => {
              try {
                if (!session) {
                  throw new Error("в ветке нет сессии: войдите заново");
                }
                await ctx.client.putSecret("TG_STRING_SESSION", session);
                setStatus(status, "Секрет записан, убираю копию из ветки…");
                await bridge.saveState({ session: null });
                setStatus(status, "Готово.", "ok");
                await ctx.refresh({ silent: true });
                render();
              } catch (error) {
                setStatus(
                  status,
                  `${error.message} Дайджесты будут работать, но доступ к сессии есть у любого, кто читает репозиторий.`,
                  "warn",
                );
              }
            },
          }),
      status,
      button({
        label: "К настройкам",
        variant: inSecrets ? "primary" : "ghost",
        block: true,
        onClick: () => ctx.navigate("settings"),
      }),
    );
  }

  function render() {
    if (step === "app") {
      renderAppStep();
    } else if (step === "code") {
      renderCodeStep();
    } else {
      renderSessionStep();
    }
  }

  step = initialStep();
  render();
  return { title: "Вход в Telegram", node, back: true };
}
