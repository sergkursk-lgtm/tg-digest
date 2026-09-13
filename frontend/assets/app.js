/**
 * Application shell: theme, routing, the PIN gate and boot.
 *
 * The page has three states that never mix: a lock screen, first-run onboarding, and the
 * app itself with three tabs. Everything else — a digest, the Telegram login — is a screen
 * pushed on top of a tab, so the header's back button always means "one step back".
 *
 * What this file is careful about:
 *
 *   * the GitHub token only ever exists in memory or encrypted in localStorage;
 *   * a credential is never logged, put in a URL, or passed as a workflow input;
 *   * digest HTML, which originates in Telegram, is sanitised before it reaches the DOM.
 */

import { createGitHub } from "./api.js";
import { createLoginBridge } from "./backend.js";
import { openVault } from "./crypto.js";
import { clear, el } from "./dom.js";
import { clearVault, loadRepo, loadVault } from "./local.js";
import { createLockScreen } from "./lock.js";
import { setupMiniApp, themeFromTelegram } from "./miniapp.js";
import { createOnboardingScreen, createTokenStep } from "./onboarding.js";
import { createChannelsScreen } from "./screen-channels.js";
import { createDigestDetail, createDigestsScreen } from "./screen-digests.js";
import { createSettingsScreen, createTelegramLoginScreen } from "./screen-settings.js";
import { isSetupComplete, loadSnapshot, secretsFromSetupRun, setupSteps } from "./state.js";
import { haptic, icon, installPressFeedback, toast } from "./ui.js";

const THEME_KEY = "tg-digest.theme";
const ONBOARDED_KEY = "tg-digest.onboarded";
const THEME_ORDER = ["system", "light", "dark"];
const THEME_LABELS = { system: "как в системе", light: "светлая", dark: "тёмная" };
const THEME_ICONS = { system: "system", light: "sun", dark: "moon" };

const nacl = globalThis.nacl;

/** The tabs, in the order they appear at the bottom. */
const TABS = [
  { id: "digests", title: "Дайджесты", icon: "digests" },
  { id: "channels", title: "Каналы", icon: "channels" },
  { id: "settings", title: "Настройки", icon: "settings" },
];

const views = document.getElementById("views");
const appbar = document.getElementById("appbar");
const appbarTitle = document.getElementById("appbar-title");
const backButton = document.getElementById("nav-back");
const themeButton = document.getElementById("theme-toggle");
const tabbar = document.getElementById("tabbar");

/** The token-backed client, the loaded data, and the secret names. */
const context = {
  client: null,
  snapshot: null,
  secretNames: [],
  // False when the token can write secrets but not list them, which is the normal state
  // for a fine-grained PAT without Secrets: read. The UI says "неизвестно" rather than
  // claiming a credential that exists is missing.
  secretsReadable: true,
  loginBridge: null,
};

/** Read the secret names, reporting whether the repository allowed it. */
async function readSecretNames(client) {
  try {
    return { names: await client.listSecretNames(), readable: true };
  } catch (error) {
    return { names: [], readable: false };
  }
}

/** Where the user is: an active tab plus a stack of pushed screens. */
let activeTab = "digests";
let stack = [];

// -- theme --------------------------------------------------------------------

/**
 * The theme Telegram is using, when the page runs as a Mini App.
 *
 * Inside Telegram this is a better "system" answer than the OS preference: the client's
 * theme is what the user actually sees around the page.
 */
let telegramTheme = null;

/** Apply a theme choice to the document. */
function applyTheme(theme) {
  const systemDark = telegramTheme
    ? telegramTheme === "dark"
    : window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = theme === "dark" || (theme !== "light" && systemDark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";

  if (themeButton) {
    clear(themeButton);
    themeButton.append(icon(THEME_ICONS[theme] ?? "system", 20));
    themeButton.setAttribute("aria-label", `Тема: ${THEME_LABELS[theme] ?? theme}`);
    themeButton.title = `Тема: ${THEME_LABELS[theme] ?? theme}`;
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

/** Store and apply a theme choice. */
function setTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (error) {
    /* storage may be unavailable; the choice then just does not persist */
  }
  applyTheme(theme);
}

/** Wire the theme button: it cycles system → light → dark. */
function initTheme() {
  applyTheme(readTheme());

  themeButton?.addEventListener("click", () => {
    haptic("select");
    const current = readTheme();
    setTheme(THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length]);
  });

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (readTheme() === "system") {
      applyTheme("system");
    }
  });
}

// -- chrome -------------------------------------------------------------------

/** Render the bottom navigation. */
function renderTabs() {
  if (!tabbar) {
    return;
  }
  clear(tabbar);
  for (const tab of TABS) {
    const active = tab.id === activeTab && !stack.length;
    tabbar.append(
      el(
        "button",
        {
          class: `tabbar__item${active ? " tabbar__item--active" : ""}`,
          type: "button",
          "aria-current": active ? "page" : null,
          on: {
            click: () => {
              if (active) {
                return;
              }
              haptic("select");
              stack = [];
              activeTab = tab.id;
              render();
            },
          },
        },
        [icon(tab.icon, 22), el("span", { text: tab.title })],
      ),
    );
  }
}

/** Show or hide the app chrome. */
function setChrome({ appbar: showBar = false, tabs = false } = {}) {
  if (appbar) {
    appbar.hidden = !showBar;
  }
  if (tabbar) {
    tabbar.hidden = !tabs;
  }
}

/** Show the Telegram client's own back button when a screen was pushed. */
function syncNativeBackButton() {
  const back = globalThis.Telegram?.WebApp?.BackButton;
  if (!back) {
    return;
  }
  if (stack.length) {
    back.show?.();
  } else {
    back.hide?.();
  }
}

// -- routing ------------------------------------------------------------------

/** Go to a tab, or push a screen onto the current tab. */
function navigate(route, params = {}) {
  const isTab = TABS.some((tab) => tab.id === route);
  if (isTab) {
    activeTab = route;
    stack = [];
  } else {
    stack.push({ route, params });
  }
  render();
}

/** One step back. */
function back() {
  if (!stack.length) {
    return;
  }
  stack.pop();
  render();
}

/** Build the screen the current route describes. */
function buildScreen() {
  const top = stack.length ? stack[stack.length - 1] : null;
  const route = top?.route ?? activeTab;

  const ctx = {
    client: context.client,
    snapshot: context.snapshot,
    secretNames: context.secretNames,
    loginBridge: context.loginBridge,
    navigate,
    back,
    refresh,
    hasSecret: (name) =>
      context.secretNames.includes(name) ||
      secretsFromSetupRun(context.snapshot?.setupRun).has(name),
    secretsReadable: context.secretsReadable,
    currentTheme: readTheme,
    setTheme,
    onForgetToken: () => {
      clearVault();
      context.client = null;
      context.snapshot = null;
      stack = [];
      showWelcome();
    },
    finishOnboarding: () => {
      try {
        localStorage.setItem(ONBOARDED_KEY, "1");
      } catch (error) {
        /* the checklist simply reappears next time */
      }
      activeTab = "digests";
      stack = [];
      render();
    },
  };

  switch (route) {
    case "digests":
      return createDigestsScreen(ctx);
    case "channels":
      return createChannelsScreen(ctx);
    case "settings":
      return createSettingsScreen(ctx);
    case "digest":
      return createDigestDetail(ctx, top.params.id);
    case "telegram-login":
      return createTelegramLoginScreen(ctx);
    case "onboarding":
      return createOnboardingScreen(ctx);
    default:
      return createDigestsScreen(ctx);
  }
}

/** Draw the current route and the chrome that belongs with it. */
function render() {
  const screen = buildScreen();

  clear(views);
  if (screen.floating) {
    // The last row must not end up underneath the floating button.
    screen.node.classList.add("screen--with-fab");
    views.append(screen.node, screen.floating);
  } else {
    views.append(screen.node);
  }
  if (appbarTitle) {
    appbarTitle.textContent = screen.title ?? "tg-digest";
  }
  if (backButton) {
    backButton.hidden = !screen.back;
  }
  // A pushed screen keeps the header but drops the tabs; onboarding drops both, because
  // there is nothing to navigate to until it is done.
  setChrome({
    appbar: true,
    tabs: !stack.length,
    ...(screen.chrome ?? {}),
  });
  renderTabs();
  syncNativeBackButton();
  window.scrollTo({ top: 0 });
}

/** Reload the data branch and redraw. */
async function refresh({ silent = false } = {}) {
  if (!context.client) {
    return;
  }
  try {
    const [snapshot, secrets] = await Promise.all([
      loadSnapshot(context.client),
      readSecretNames(context.client),
    ]);
    context.snapshot = snapshot;
    context.secretNames = secrets.names;
    context.secretsReadable = secrets.readable;
  } catch (error) {
    toast(`Не удалось прочитать данные: ${error.message}`, "error");
    return;
  }
  render();
  if (!silent) {
    toast("Обновлено", "ok");
  }
}

// -- the lock -----------------------------------------------------------------

let lock = null;

/** Show the welcome screen: the GitHub token and the PIN. */
function showWelcome() {
  setChrome({});
  stack = [];
  const tokenStep = createTokenStep({
    mount: views,
    nacl,
    clientFactory: ({ owner, repo, token }) => createGitHub({ owner, repo, token, nacl }),
    onDone: (client) => startWithToken(client, { fresh: true }),
  });
  tokenStep.render();
}

/** Ask for the PIN and decrypt the stored token. */
function showLock() {
  setChrome({});
  stack = [];
  lock = createLockScreen({
    mount: views,
    onSubmit: async (pin) => {
      const token = await openVault(pin, loadVault());
      const repo = loadRepo();
      const client = createGitHub({ ...repo, token, nacl });
      // A stored token can be revoked; proving it still works here means the lock screen
      // is where that is reported, rather than a half-drawn app.
      try {
        await client.whoami();
      } catch (error) {
        throw new Error("Токен больше не принимается GitHub. Введите токен заново.");
      }
      lock?.destroy();
      lock = null;
      await startWithToken(client, { fresh: false });
    },
    onForgot: () => {
      clearVault();
      showWelcome();
    },
  });
  lock.render();
}

// -- boot ---------------------------------------------------------------------

/** Turn a validated token into a running application. */
async function startWithToken(client, { fresh }) {
  context.client = client;
  context.loginBridge = createLoginBridge(client);

  try {
    const [snapshot, secrets] = await Promise.all([loadSnapshot(client), readSecretNames(client)]);
    context.snapshot = snapshot;
    context.secretNames = secrets.names;
    context.secretsReadable = secrets.readable;
  } catch (error) {
    context.client = null;
    showWelcome();
    toast(`Не удалось прочитать репозиторий: ${error.message}`, "error");
    return;
  }

  const steps = setupSteps(context.snapshot, context.secretNames);
  const dismissed = (() => {
    try {
      return localStorage.getItem(ONBOARDED_KEY) === "1";
    } catch (error) {
      return false;
    }
  })();

  // First run, or a setup that is still missing something required: show the checklist
  // once, then stay out of the way.
  if (fresh || (!isSetupComplete(steps) && !dismissed)) {
    stack = [];
    activeTab = "digests";
    navigate("onboarding");
    return;
  }

  activeTab = "digests";
  stack = [];
  render();
}

/** Start the application. */
function boot() {
  const miniApp = setupMiniApp({
    scope: window,
    onThemeChange: (theme) => {
      telegramTheme = theme;
      // Telegram's theme only wins while the user has not chosen one themselves.
      if (readTheme() === "system") {
        applyTheme("system");
      }
    },
  });
  if (miniApp) {
    telegramTheme = themeFromTelegram(miniApp);
    miniApp.BackButton?.onClick?.(() => back());
  }

  initTheme();
  // Safari on iOS will not show `:active` on a button unless the page listens for touches,
  // so the pressed state is painted from pointer events instead of left to the browser.
  installPressFeedback(document);
  backButton?.addEventListener("click", () => {
    haptic("light");
    back();
  });

  if (!nacl) {
    context.snapshot = null;
    views.append(
      el("section", { class: "screen screen--narrow" }, [
        el("div", { class: "card" }, [
          el("h1", { text: "Не удалось запуститься" }),
          el("p", {
            class: "status status--error",
            text: "Не загрузилась библиотека шифрования (vendor/tweetnacl.js). Обновите страницу.",
          }),
        ]),
      ]),
    );
    return;
  }

  if (loadVault()) {
    showLock();
  } else {
    showWelcome();
  }
}

boot();
