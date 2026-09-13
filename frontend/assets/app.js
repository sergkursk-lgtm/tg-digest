/**
 * tg-digest UI bootstrap.
 *
 * Keeps the page in sync with the user's theme choice and renders the
 * peak/off-peak tariff indicator in the footer. Everything else is added in
 * later stages; there is no framework and no build step here by design.
 */

import { MODEL, tariffLabel, tariffSnapshot } from "./tariff.js";

const THEME_KEY = "tg-digest.theme";
const THEME_ORDER = ["system", "light", "dark"];
const THEME_LABELS = {
  system: "системная",
  light: "светлая",
  dark: "тёмная",
};

/** Read the stored theme choice, falling back to "system". */
function readTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return THEME_ORDER.includes(stored) ? stored : "system";
  } catch (error) {
    return "system";
  }
}

/** Persist the theme choice; private mode may refuse to write, which is fine. */
function writeTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (error) {
    /* Storage unavailable: the choice simply does not survive a reload. */
  }
}

/** Apply a theme choice to the document and update the toggle label. */
function applyTheme(theme) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = theme === "dark" || (theme !== "light" && prefersDark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";

  const toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.textContent = `Тема: ${THEME_LABELS[theme]}`;
    toggle.setAttribute("aria-label", `Переключить тему, сейчас ${THEME_LABELS[theme]}`);
  }
}

/** Wire up the theme toggle button. */
function initThemeToggle() {
  let theme = readTheme();
  applyTheme(theme);

  const toggle = document.getElementById("theme-toggle");
  if (!toggle) {
    return;
  }
  toggle.addEventListener("click", () => {
    theme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    writeTheme(theme);
    applyTheme(theme);
  });

  // Follow the system only while the user has not overridden it.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (theme === "system") {
      applyTheme(theme);
    }
  });
}

/** Render the footer tariff indicator for the current moment. */
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

initThemeToggle();
renderTariff();
setInterval(renderTariff, 30_000);
