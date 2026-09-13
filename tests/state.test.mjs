/**
 * Tests for the setup checklist and the footer figures.
 *
 * These are the rules that decide what the wizard asks for, so they are worth testing
 * independently of the DOM.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatMoment,
  formatTokens,
  formatUsd,
  isSetupComplete,
  monthKey,
  nextStepId,
  pendingSteps,
  setupSteps,
  usageSummary,
} from "../frontend/assets/state.js";

/** Build a snapshot with sensible defaults. */
function snapshot(overrides = {}) {
  return {
    settings: { values: { telegram: { bot_token: "", chat_id: "" } } },
    login: null,
    channels: [],
    ...overrides,
  };
}

/** Return a step by id. */
function step(steps, id) {
  return steps.find((entry) => entry.id === id);
}

// -- the checklist ------------------------------------------------------------

test("nothing configured leaves every visible step pending", () => {
  const steps = setupSteps(snapshot(), []);
  assert.deepEqual(
    pendingSteps(steps).map((entry) => entry.id),
    ["telegram-app", "deepseek", "bot", "channels"],
  );
  assert.equal(nextStepId(steps), "telegram-app");
  assert.equal(isSetupComplete(steps), false);
});

test("api credentials already in Secrets count as configured", () => {
  const steps = setupSteps(snapshot(), ["TG_API_ID", "TG_API_HASH"]);
  assert.equal(step(steps, "telegram-app").done, true);
});

test("api credentials from the data branch count as configured", () => {
  const steps = setupSteps(snapshot({ login: { api_id: 1, api_hash: "h", phone: "+7" } }), []);
  assert.equal(step(steps, "telegram-app").done, true);
});

test("after login the code step disappears and the promote step appears", () => {
  const steps = setupSteps(snapshot({ login: { step: "authorized", api_id: 1, api_hash: "h" } }), []);
  assert.equal(step(steps, "telegram-code").hidden, true);
  assert.equal(step(steps, "telegram-session").hidden, false);
  assert.equal(step(steps, "telegram-session").done, false);
});

test("a session already in Secrets needs neither the code nor the promote step", () => {
  const steps = setupSteps(
    snapshot({ login: { step: "authorized", api_id: 1, api_hash: "h" } }),
    ["TG_STRING_SESSION"],
  );
  assert.equal(step(steps, "telegram-code").hidden, true);
  assert.equal(step(steps, "telegram-session").hidden, true);
  assert.equal(isSetupComplete(steps), false); // deepseek, bot and channels remain
});

test("a failed login leaves the code step visible so it can be retried", () => {
  const steps = setupSteps(snapshot({ login: { step: "failed", api_id: 1, api_hash: "h" } }), []);
  assert.equal(step(steps, "telegram-code").hidden, false);
  assert.equal(step(steps, "telegram-code").done, false);
  assert.equal(nextStepId(steps), "telegram-code");
});

test("bot delivery needs both the token and the chat id", () => {
  const partial = snapshot({
    settings: { values: { telegram: { bot_token: "123:abc", chat_id: "" } } },
  });
  assert.equal(step(setupSteps(partial, []), "bot").done, false);

  const complete = snapshot({
    settings: { values: { telegram: { bot_token: "123:abc", chat_id: "42" } } },
  });
  assert.equal(step(setupSteps(complete, []), "bot").done, true);
});

test("one channel is enough", () => {
  const steps = setupSteps(snapshot({ channels: [{ id: 1 }] }), []);
  assert.equal(step(steps, "channels").done, true);
});

test("a fully configured project reports setup complete", () => {
  const steps = setupSteps(
    snapshot({
      login: { step: "authorized", api_id: 1, api_hash: "h" },
      settings: { values: { telegram: { bot_token: "123:abc", chat_id: "42" } } },
      channels: [{ id: 1 }],
    }),
    ["TG_STRING_SESSION", "DEEPSEEK_API_KEY"],
  );
  assert.equal(isSetupComplete(steps), true);
  assert.equal(nextStepId(steps), null);
});

test("an empty snapshot does not throw", () => {
  assert.doesNotThrow(() => setupSteps({}, []));
  assert.equal(isSetupComplete(setupSteps({}, [])), false);
});

// -- footer figures -----------------------------------------------------------

test("monthKey uses UTC", () => {
  assert.equal(monthKey(new Date(Date.UTC(2026, 8, 13, 23, 0))), "2026-09");
  assert.equal(monthKey(new Date(Date.UTC(2026, 11, 1, 0, 0))), "2026-12");
});

test("usageSummary adds up the month", () => {
  const summary = usageSummary(
    { totals: { digests: 3, tokens_in: 1000, tokens_out: 100, cache_hit_tokens: 500, cost_usd: 1.5 } },
    { values: { budget: { monthly_usd: 5, warn_ratio: 0.8 } } },
  );
  assert.equal(summary.digests, 3);
  assert.equal(summary.costUsd, 1.5);
  assert.equal(summary.status, "ok");
  assert.equal(summary.ratio, 0.3);
});

test("usageSummary warns at the warning ratio", () => {
  const summary = usageSummary({ totals: { cost_usd: 4 } }, { values: { budget: {} } });
  assert.equal(summary.status, "warn");
});

test("usageSummary blocks at the limit", () => {
  const summary = usageSummary({ totals: { cost_usd: 5 } }, { values: { budget: {} } });
  assert.equal(summary.status, "blocked");
  assert.equal(summary.ratio, 1);
});

test("usageSummary survives a missing usage file and settings", () => {
  const summary = usageSummary(null, null);
  assert.equal(summary.digests, 0);
  assert.equal(summary.limitUsd, 5);
  assert.equal(summary.status, "ok");
});

test("formatters render Russian-friendly strings", () => {
  assert.match(formatTokens(1234567), /1\s?234\s?567/);
  assert.equal(formatUsd(0.0136), "$0.0136");
  assert.equal(formatMoment(null), "—");
  assert.equal(formatMoment("not a date"), "—");
  assert.notEqual(formatMoment("2026-09-13T12:00:00Z"), "—");
});
