/**
 * Telegram Mini App integration.
 *
 * The same page runs in two places: an ordinary browser and the bot's Mini App. Inside
 * Telegram we take the theme and the viewport from the client, so the app looks native
 * instead of merely embedded.
 *
 * What we deliberately do **not** do with `initData`: trust it. Verifying it requires a
 * server to check the HMAC with the bot token, and this project has none. It is used only
 * as a signal that we are inside Telegram.
 *
 * The official SDK is vendored rather than loaded from telegram.org, the same rule as the
 * rest of the page: see `frontend/vendor/README.md`.
 */

/**
 * Return the Telegram WebApp object, or null when the page is not inside Telegram.
 * @param {object} [scope] global object, injected for tests
 */
export function telegramWebApp(scope = globalThis) {
  const app = scope?.Telegram?.WebApp;
  return app && typeof app === "object" ? app : null;
}

/**
 * True when the page was opened as a Mini App.
 *
 * `initData` is only present when Telegram launched the page, which is a better signal than
 * the platform string: the SDK also runs in a normal browser and reports a platform there.
 *
 * @param {object|null} app
 */
export function isMiniApp(app) {
  return Boolean(app && typeof app.initData === "string" && app.initData.length > 0);
}

/**
 * The theme Telegram is using.
 * @param {object|null} app
 * @returns {"light"|"dark"}
 */
export function themeFromTelegram(app) {
  return app?.colorScheme === "dark" ? "dark" : "light";
}

/**
 * Translate Telegram's safe-area insets into CSS variables.
 *
 * The Mini App is a full-screen webview, so the header would otherwise sit under the
 * Telegram chrome.
 *
 * @param {object|null} app
 * @param {HTMLElement} [root]
 * @returns {Record<string, string>} the variables that were set
 */
export function applySafeArea(app, root = globalThis.document?.documentElement) {
  const insets = app?.contentSafeAreaInset ?? app?.safeAreaInset;
  if (!root || !insets) {
    return {};
  }
  const variables = {
    "--tg-inset-top": `${Number(insets.top ?? 0)}px`,
    "--tg-inset-bottom": `${Number(insets.bottom ?? 0)}px`,
    "--tg-inset-left": `${Number(insets.left ?? 0)}px`,
    "--tg-inset-right": `${Number(insets.right ?? 0)}px`,
  };
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }
  return variables;
}

/**
 * Prepare the page for the Mini App, when it is one.
 *
 * @param {object} options
 * @param {object} [options.scope] global object, injected for tests
 * @param {Function} [options.onThemeChange] called with the theme whenever it changes
 * @returns {object|null} the WebApp object when running inside Telegram
 */
export function setupMiniApp({ scope = globalThis, onThemeChange } = {}) {
  const app = telegramWebApp(scope);
  if (!isMiniApp(app)) {
    return null;
  }

  // Tell Telegram we are drawn, and ask for the full height instead of a half sheet.
  app.ready?.();
  app.expand?.();
  applySafeArea(app, scope.document?.documentElement);
  scope.document?.documentElement?.setAttribute("data-miniapp", "true");

  if (onThemeChange) {
    app.onEvent?.("themeChanged", () => onThemeChange(themeFromTelegram(app)));
  }
  return app;
}
