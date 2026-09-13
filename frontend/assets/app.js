/**
 * Application bootstrap: theme, PIN lock, the setup wizard and the dashboard.
 *
 * Everything here runs in the browser with no server. The three things it is careful
 * about:
 *
 *   * the GitHub token only ever exists in memory or encrypted in localStorage;
 *   * the setup wizard is shown until every required step is done, so a half-configured
 *     project cannot pretend to be ready;
 *   * digest HTML, which originates in Telegram, is sanitised before it reaches the DOM.
 */

import { createGitHub } from "./api.js";
import { WrongPinError, openVault } from "./crypto.js";
import { clear, el, field, setStatus, statusLine } from "./dom.js";
import { clearVault, loadRepo, loadVault } from "./local.js";
import { sanitizeHtml } from "./sanitize.js";
import {
  PATHS,
  formatMoment,
  formatTokens,
  formatUsd,
  isSetupComplete,
  loadSnapshot,
  setupSteps,
  usageSummary,
} from "./state.js";
import { MODEL, tariffLabel, tariffSnapshot } from "./tariff.js";
import { createWizard } from "./wizard.js";

const THEME_KEY = "tg-digest.theme";
const THEME_ORDER = ["system", "light", "dark"];
const THEME_LABELS = { system: "системная", light: "светлая", dark: "тёмная" };

const nacl = globalThis.nacl;

/** Mutable holder so the token step can install a freshly validated client. */
const context = { client: null };

let snapshot = null;
let updateFooter = () => {};

const views = {
  welcome: document.getElementById("view-welcome"),
  lock: document.getElementById("view-lock"),
  wizard: document.getElementById("view-wizard"),
  app: document.getElementById("view-app"),
};

/** Show exactly one view. */
function showView(name) {
  for (const [key, node] of Object.entries(views)) {
    node.hidden = key !== name;
  }
}

// -- chrome -------------------------------------------------------------------

/** Apply a theme choice to the document. */
function applyTheme(theme) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = theme === "dark" || (theme !== "light" && prefersDark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.textContent = `Тема: ${THEME_LABELS[theme]}`;
  }
}

/** Read the stored theme, defaulting to the system setting. */
function readTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return THEME_ORDER.includes(stored) ? stored : "system";
  } catch (error) {
    return "system";
  }
}

/** Wire the theme toggle. */
function initTheme() {
  let theme = readTheme();
  applyTheme(theme);

  const toggle = document.getElementById("theme-toggle");
  toggle?.addEventListener("click", () => {
    theme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (error) {
      /* storage may be unavailable; the choice then just does not persist */
    }
    applyTheme(theme);
  });

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (theme === "system") {
      applyTheme(theme);
    }
  });
}

/** Render the tariff indicator in the footer. */
function renderTariff() {
  const node = document.getElementById("tariff");
  if (!node) {
    return;
  }
  const now = new Date();
  node.textContent = tariffLabel(now);
  node.dataset.tariff = tariffSnapshot(now).tariff;
  const model = document.getElementById("footer-model");
  if (model) {
    model.textContent = MODEL;
  }
}

/** Show a fatal problem that prevents the app from running at all. */
function fatal(message) {
  const node = views.welcome;
  clear(node);
  node.append(
    el("section", { class: "card" }, [
      el("h1", { text: "Не удалось запуститься" }),
      el("p", { class: "status status--error", text: message }),
    ]),
  );
  showView("welcome");
}

// -- the lock -----------------------------------------------------------------

/** Ask for the PIN and decrypt the stored token. */
function showLock(message = "") {
  const status = statusLine(message, "error");
  const pin = field({ label: "PIN", type: "password", maxlength: 12 });
  const submit = el("button", {
    class: "button button--primary",
    type: "submit",
    text: "Открыть",
  });

  const form = el("form", { class: "card" }, [
    el("h1", { text: "tg-digest" }),
    el("p", { class: "lede", text: "Введите PIN, чтобы расшифровать токен GitHub." }),
    pin.field,
    submit,
    status,
    el("button", {
      class: "button button--link",
      type: "button",
      text: "Забыли PIN? Ввести токен заново",
      on: {
        click: () => {
          clearVault();
          context.client = null;
          showWelcome();
        },
      },
    }),
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const token = await openVault(pin.input.value, loadVault());
      await startWithToken(token);
    } catch (error) {
      setStatus(
        status,
        error instanceof WrongPinError ? "Неверный PIN" : error.message,
        "error",
      );
    } finally {
      submit.disabled = false;
    }
  });

  clear(views.lock);
  views.lock.append(form);
  showView("lock");
  pin.input.focus();
}

// -- the wizard ---------------------------------------------------------------

let wizard = null;

/** Create the token step and, once a token exists, the whole wizard. */
function showWelcome() {
  clear(views.welcome);
  const intro = el("section", { class: "card" }, [
    el("h1", { text: "tg-digest" }),
    el("p", {
      class: "lede",
      text: "Дайджесты из Telegram-каналов: читаем сообщения, сжимаем через DeepSeek, отдаём сюда и в Telegram-бота.",
    }),
    el("p", {
      class: "muted",
      text: "Понадобится GitHub-токен с правами Actions, Contents и Secrets. Он будет храниться только в этом браузере, зашифрованный PIN-ом.",
    }),
  ]);
  const step = el("section", { class: "card card--step" });

  wizard = createWizard({
    mount: views.wizard,
    context,
    nacl,
    clientFactory: ({ owner, repo, token }) => createGitHub({ owner, repo, token, nacl }),
    refresh: () => render(),
    onComplete: async ({ client }) => {
      context.client = client;
      await loadAndRender();
    },
  });
  wizard.renderTokenStep(step);

  views.welcome.append(intro, step);
  showView("welcome");
}

/** Build a client from an already validated token and load the project state. */
async function startWithToken(token) {
  if (!nacl) {
    fatal("Не загрузилась библиотека шифрования — обновите страницу.");
    return;
  }
  const repo = loadRepo();
  context.client = createGitHub({ ...repo, token, nacl });

  wizard = createWizard({
    mount: views.wizard,
    context,
    nacl,
    clientFactory: ({ owner, repo: name, token: fresh }) =>
      createGitHub({ owner, repo: name, token: fresh, nacl }),
    refresh: () => render(),
    onComplete: () => render(),
  });
  await loadAndRender();
}

/** Reload the snapshot and decide between the wizard and the dashboard. */
async function loadAndRender() {
  if (!context.client) {
    showWelcome();
    return;
  }
  try {
    snapshot = await loadSnapshot(context.client);
  } catch (error) {
    fatal(`Не удалось прочитать данные из репозитория: ${error.message}`);
    return;
  }
  await render();
}

/** Render either the wizard or the dashboard, depending on the checklist. */
async function render() {
  if (!snapshot) {
    return;
  }
  let secretNames = [];
  try {
    secretNames = await context.client.listSecretNames();
  } catch (error) {
    secretNames = [];
  }
  const steps = setupSteps(snapshot, secretNames);
  updateFooter(usageSummary(snapshot.usage, snapshot.settings), snapshot);

  if (!isSetupComplete(steps)) {
    await wizard.start();
    showView("wizard");
    return;
  }
  renderDashboard();
  showView("app");
}

// -- the dashboard ------------------------------------------------------------

/** Render channels, recent digests and the verification panel. */
function renderDashboard() {
  const node = views.app;
  clear(node);

  const status = statusLine();
  const runRow = el("div", { class: "row" }, [
    el("button", {
      class: "button button--primary",
      type: "button",
      text: "Запустить все каналы",
      on: {
        click: async () => {
          await startDigest(snapshot.channels.map((channel) => channel.id));
        },
      },
    }),
    el("button", {
      class: "button",
      type: "button",
      text: "Проверить настройки",
      on: {
        click: async () => {
          await runSetupCheck(status);
        },
      },
    }),
    el("button", {
      class: "button button--link",
      type: "button",
      text: "Настройка заново",
      on: {
        click: async () => {
          await wizard.start();
          showView("wizard");
        },
      },
    }),
  ]);

  node.append(
    el("section", { class: "card" }, [
      el("h1", { text: "Дашборд" }),
      el("p", {
        class: "lede",
        text: snapshot.channels.length
          ? `Каналов: ${snapshot.channels.length}. Период — у каждого свой.`
          : "Каналов пока нет.",
      }),
      runRow,
      status,
      renderChannels(),
      renderSetupTable(),
    ]),
    renderDigests(),
  );
}

/** The channel list with a per-channel run button. */
function renderChannels() {
  if (!snapshot.channels.length) {
    return el("p", { class: "muted", text: "Добавьте канал в мастере настройки." });
  }
  return el(
    "ul",
    { class: "list" },
    snapshot.channels.map((channel) =>
      el("li", { class: "list__item" }, [
        el("div", {}, [
          el("span", { class: "list__title", text: channel.title }),
          el("span", {
            class: "list__sub",
            text: ` ${channel.type} · период ${channel.default_period_hours} ч · ${
              channel.username ? `@${channel.username}` : channel.tg_id
            }`,
          }),
        ]),
        el("button", {
          class: "button",
          type: "button",
          text: "Запустить",
          on: {
            click: async (event) => {
              event.currentTarget.disabled = true;
              await startDigest([channel.id]);
            },
          },
        }),
      ]),
    ),
  );
}

/** The last verification table written by setup.yml, if any. */
function renderSetupTable() {
  const record = snapshot.setupRun;
  if (!record?.steps?.length) {
    return el("p", { class: "muted", text: "Проверка ещё не запускалась." });
  }
  const failed = record.status !== "ok";
  return el("div", {}, [
    el("h2", { text: "Последняя проверка" }),
    el("p", {
      class: `status status--${failed ? "error" : "ok"}`,
      text: `${formatMoment(record.finished_at ?? record.updated_at)} — ${
        failed ? "есть проблемы" : "всё в порядке"
      }`,
    }),
    el(
      "ul",
      { class: "list list--tight" },
      record.steps.map((step) =>
        el("li", { class: "list__item" }, [
          el("span", { class: `dot dot--${step.status}` }),
          el("span", { class: "list__title", text: step.name }),
          el("span", { class: "list__sub", text: step.detail ?? "" }),
        ]),
      ),
    ),
  ]);
}

/** Recent digests, newest first. */
function renderDigests() {
  const card = el("section", { class: "card" }, [el("h2", { text: "Последние дайджесты" })]);
  const preview = el("div", { class: "digest" });

  if (!snapshot.digests.length) {
    card.append(el("p", { class: "muted", text: "Пока ничего не собрано." }));
    return card;
  }

  card.append(
    el(
      "ul",
      { class: "list" },
      snapshot.digests.slice(0, 20).map((item) =>
        el("li", { class: "list__item" }, [
          el("div", {}, [
            el("span", { class: "list__title", text: item.channel_title }),
            el("span", {
              class: "list__sub",
              text: ` ${formatMoment(item.period_end)} · ${item.messages_used} сообщений · ${formatUsd(item.cost_usd)}`,
            }),
          ]),
          el("button", {
            class: "button",
            type: "button",
            text: "Открыть",
            on: {
              click: async () => {
                const stored = await context.client.readJson(`data/digests/${item.id}.json`);
                clear(preview);
                if (!stored) {
                  preview.append(el("p", { class: "status status--error", text: "Дайджест не найден." }));
                  return;
                }
                // Second layer of defence: the backend already whitelisted the markup,
                // and this refuses to insert anything that is not on the list.
                preview.append(sanitizeHtml(stored.data.html ?? ""));
              },
            },
          }),
        ]),
      ),
    ),
    preview,
  );
  return card;
}

// -- actions ------------------------------------------------------------------

/** Dispatch a digest run and follow it to completion. */
async function startDigest(channelIds) {
  const status = document.querySelector("#view-app .status");
  if (!channelIds.length) {
    setStatus(status, "Нет каналов для запуска.", "warn");
    return;
  }
  try {
    setStatus(status, "Отправляю задание в GitHub Actions…");
    const before = await context.client.latestRun("digest.yml");
    await context.client.dispatch("digest.yml", {
      channel_ids: channelIds.join(","),
      period_hours: "",
      dry_run: "false",
    });

    const run = await pollUntil(
      async () => {
        const latest = await context.client.latestRun("digest.yml");
        return latest && latest.id !== before?.id ? latest : null;
      },
      { intervalMs: 4000, timeoutMs: 90_000 },
    );
    if (!run) {
      setStatus(status, "Запуск не появился в Actions за полторы минуты — откройте вкладку Actions.", "warn");
      return;
    }

    setStatus(status, "Дайджест собирается…", "info");
    const record = await pollUntil(
      async () => {
        const stored = await context.client.readJson(`data/runs/${run.id}.json`);
        const data = stored?.data;
        return data && data.status !== "running" ? data : null;
      },
      { intervalMs: 5000, timeoutMs: 15 * 60_000 },
    );

    if (!record) {
      setStatus(status, "Прогон идёт дольше 15 минут — смотрите Actions.", "warn");
      return;
    }
    if (record.status === "ok") {
      setStatus(status, "Готово. Дайджест в списке ниже и в Telegram.", "ok");
    } else {
      setStatus(status, `Прогон завершился с ошибкой: ${record.error ?? "без подробностей"}`, "error");
    }
    await loadAndRender();
  } catch (error) {
    setStatus(status, error.message, "error");
  }
}

/** Run setup.yml and wait for the verification table it writes. */
async function runSetupCheck(status) {
  try {
    setStatus(status, "Запускаю проверку…");
    const before = snapshot.setupRun?.finished_at ?? null;
    await context.client.dispatch("setup.yml", {});
    const fresh = await pollUntil(
      async () => {
        const stored = await context.client.readJson(PATHS.setupRun);
        const finished = stored?.data?.finished_at ?? null;
        return finished && finished !== before ? stored.data : null;
      },
      { intervalMs: 5000, timeoutMs: 10 * 60_000 },
    );
    if (!fresh) {
      setStatus(status, "Проверка не завершилась за 10 минут — смотрите Actions.", "warn");
      return;
    }
    snapshot.setupRun = fresh;
    renderDashboard();
    setStatus(
      document.querySelector("#view-app .status"),
      fresh.status === "ok" ? "Проверка пройдена." : "Проверка нашла проблемы — подробности ниже.",
      fresh.status === "ok" ? "ok" : "error",
    );
  } catch (error) {
    setStatus(status, error.message, "error");
  }
}

/** Poll a probe until it returns something truthy or the deadline passes. */
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

// -- boot ---------------------------------------------------------------------

/** Render the footer calculator and update it after each action. */
function initFooter() {
  const tokens = document.getElementById("footer-tokens");
  const cost = document.getElementById("footer-cost");
  const budget = document.getElementById("footer-budget");

  updateFooter = (summary, state) => {
    if (tokens) {
      tokens.textContent = `Токенов: ${formatTokens(summary.tokensIn + summary.tokensOut)}`;
    }
    if (cost) {
      cost.textContent = `Стоимость: ${formatUsd(summary.costUsd)}`;
      cost.dataset.status = summary.status;
    }
    if (budget) {
      budget.textContent = `Бюджет: ${formatUsd(summary.limitUsd)}/мес`;
    }
    if (state) {
      document.title = `tg-digest — ${state.channels.length} канал(ов)`;
    }
  };
}

/** Start the application. */
function boot() {
  initTheme();
  initFooter();
  renderTariff();
  setInterval(renderTariff, 30_000);

  if (!nacl) {
    fatal("Не загрузилась библиотека шифрования (vendor/tweetnacl.js). Обновите страницу.");
    return;
  }
  if (loadVault()) {
    showLock();
  } else {
    showWelcome();
  }
}

boot();
