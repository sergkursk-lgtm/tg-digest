/**
 * Tests for the Telegram Mini App integration.
 *
 * The interesting cases are the two environments: a normal browser, where the SDK is loaded
 * but nothing should change, and Telegram, where the theme and the safe area come from the
 * client.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applySafeArea,
  isMiniApp,
  setupMiniApp,
  telegramWebApp,
  themeFromTelegram,
} from "../frontend/assets/miniapp.js";

/** A stand-in for the Telegram WebApp object. */
function fakeApp(overrides = {}) {
  const events = {};
  return {
    initData: "query_id=AAH&user=%7B%7D&hash=abc",
    colorScheme: "light",
    contentSafeAreaInset: { top: 8, bottom: 4, left: 0, right: 0 },
    readyCalled: false,
    expandCalled: false,
    ready() {
      this.readyCalled = true;
    },
    expand() {
      this.expandCalled = true;
    },
    onEvent(name, handler) {
      events[name] = handler;
    },
    fire(name) {
      events[name]?.();
    },
    ...overrides,
  };
}

/** A stand-in for a document element that records CSS variables. */
function fakeRoot() {
  const properties = {};
  return {
    properties,
    style: { setProperty: (name, value) => { properties[name] = value; } },
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
}

// -- detection ----------------------------------------------------------------

test("no SDK, no Mini App", () => {
  assert.equal(telegramWebApp({}), null);
  assert.equal(isMiniApp(null), false);
});

test("the SDK in a plain browser is not a Mini App", () => {
  // Telegram's script also runs outside Telegram and reports a platform there; initData is
  // the signal that actually matters.
  const app = { initData: "", platform: "unknown" };
  assert.equal(isMiniApp(app), false);
});

test("initData means Telegram launched the page", () => {
  assert.equal(isMiniApp(fakeApp()), true);
});

test("the theme follows the client", () => {
  assert.equal(themeFromTelegram(fakeApp()), "light");
  assert.equal(themeFromTelegram(fakeApp({ colorScheme: "dark" })), "dark");
  assert.equal(themeFromTelegram(null), "light");
});

// -- setup --------------------------------------------------------------------

test("outside Telegram nothing is touched", () => {
  const scope = { Telegram: { WebApp: { initData: "" } }, document: { documentElement: fakeRoot() } };
  assert.equal(setupMiniApp({ scope }), null);
  assert.equal(scope.document.documentElement.attributes["data-miniapp"], undefined);
});

test("inside Telegram the app is marked ready and expanded", () => {
  const app = fakeApp();
  const root = fakeRoot();
  const scope = { Telegram: { WebApp: app }, document: { documentElement: root } };

  assert.equal(setupMiniApp({ scope }), app);
  assert.equal(app.readyCalled, true);
  assert.equal(app.expandCalled, true);
  assert.equal(root.attributes["data-miniapp"], "true");
});

test("safe-area insets become CSS variables", () => {
  const root = fakeRoot();
  const variables = applySafeArea(fakeApp(), root);
  assert.equal(variables["--tg-inset-top"], "8px");
  assert.equal(root.properties["--tg-inset-bottom"], "4px");
});

test("safe area falls back to the older field", () => {
  const root = fakeRoot();
  const app = fakeApp({ contentSafeAreaInset: undefined, safeAreaInset: { top: 20, bottom: 0, left: 0, right: 0 } });
  assert.equal(applySafeArea(app, root)["--tg-inset-top"], "20px");
});

test("missing insets leave the variables alone", () => {
  const root = fakeRoot();
  assert.deepEqual(applySafeArea(fakeApp({ contentSafeAreaInset: undefined }), root), {});
  assert.deepEqual(applySafeArea(null, root), {});
});

test("a theme change is reported to the caller", () => {
  const app = fakeApp({ colorScheme: "dark" });
  const scope = { Telegram: { WebApp: app }, document: { documentElement: fakeRoot() } };
  const seen = [];

  setupMiniApp({ scope, onThemeChange: (theme) => seen.push(theme) });
  app.fire("themeChanged");
  assert.deepEqual(seen, ["dark"]);
});

test("a client without optional methods does not crash", () => {
  const minimal = { initData: "x" };
  const scope = { Telegram: { WebApp: minimal }, document: { documentElement: fakeRoot() } };
  assert.doesNotThrow(() => setupMiniApp({ scope }));
});
