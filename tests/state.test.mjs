/**
 * Tests for the setup checklist and the footer figures.
 *
 * These are the rules that decide what the wizard asks for, so they are worth testing
 * independently of the DOM.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  briefTopics,
  digestFileName,
  formatDate,
  formatMoment,
  formatTokens,
  formatUsd,
  isNewerThan,
  isSetupComplete,
  monthKey,
  optionalSteps,
  nextStepId,
  pendingSteps,
  setupSteps,
  usageByDay,
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

test("nothing configured leaves every required step pending", () => {
  const steps = setupSteps(snapshot(), []);
  assert.deepEqual(
    pendingSteps(steps).map((entry) => entry.id),
    ["telegram-app", "deepseek", "channels"],
  );
  assert.equal(nextStepId(steps), "telegram-app");
  assert.equal(isSetupComplete(steps), false);
});

test("delivery is offered but does not block the application", () => {
  // A digest is stored and readable without a bot; refusing to show anything until
  // delivery is configured would be the wrong way round.
  const steps = setupSteps(
    snapshot({
      login: { step: "authorized", api_id: 1, api_hash: "h" },
      channels: [{ id: 1 }],
    }),
    ["TG_STRING_SESSION", "DEEPSEEK_API_KEY"],
  );
  assert.deepEqual(optionalSteps(steps).map((entry) => entry.id), ["bot"]);
  assert.equal(isSetupComplete(steps), true);
  assert.equal(nextStepId(steps), null);
});

test("moving the session into Secrets is optional too", () => {
  const steps = setupSteps(
    snapshot({ login: { step: "authorized", api_id: 1, api_hash: "h" } }),
    ["DEEPSEEK_API_KEY"],
  );
  // Bot delivery is still unconfigured, so it is offered as well.
  assert.deepEqual(optionalSteps(steps).map((entry) => entry.id), [
    "telegram-session",
    "bot",
  ]);
});

test("api credentials already in Secrets still require the phone and a code", () => {
  // Regression: treating the Secrets as completion sent the wizard straight to a code
  // prompt for a code nothing had sent, with nowhere to enter the phone number.
  const steps = setupSteps(snapshot(), ["TG_API_ID", "TG_API_HASH"]);
  assert.equal(step(steps, "telegram-app").done, false);
  assert.equal(step(steps, "telegram-code").hidden, true);
  assert.equal(nextStepId(steps), "telegram-app");
});

test("a requested code opens the code step", () => {
  const steps = setupSteps(snapshot({ login: { step: "code_sent", phone: "+7" } }), []);
  assert.equal(step(steps, "telegram-app").done, true);
  assert.equal(step(steps, "telegram-code").hidden, false);
  assert.equal(nextStepId(steps), "telegram-code");
});

test("credentials from the data branch count as configured", () => {
  const steps = setupSteps(snapshot({ login: { api_id: 1, api_hash: "h", step: "code_sent" } }), []);
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

test("a failed login returns to the app step so a code can be requested again", () => {
  const steps = setupSteps(snapshot({ login: { step: "failed", api_id: 1, api_hash: "h" } }), []);
  assert.equal(step(steps, "telegram-code").hidden, true);
  assert.equal(nextStepId(steps), "telegram-app");
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

test("isNewerThan ignores a previous attempt's state", () => {
  const started = Date.parse("2026-09-13T07:50:00Z");
  assert.equal(isNewerThan({ updated_at: "2026-09-13T07:44:55+00:00" }, started), false);
  assert.equal(isNewerThan({ updated_at: "2026-09-13T07:50:01+00:00" }, started), true);
  assert.equal(isNewerThan({ updated_at: "2026-09-13T07:50:00.000Z" }, started), true);
});

test("isNewerThan treats unusable timestamps as stale", () => {
  assert.equal(isNewerThan(null, 0), false);
  assert.equal(isNewerThan({}, 0), false);
  assert.equal(isNewerThan({ updated_at: "not a date" }, 0), false);
});

test("formatters render Russian-friendly strings", () => {
  assert.match(formatTokens(1234567), /1\s?234\s?567/);
  assert.equal(formatUsd(0.0136), "$0.0136");
  assert.equal(formatMoment(null), "—");
  assert.equal(formatMoment("not a date"), "—");
  assert.notEqual(formatMoment("2026-09-13T12:00:00Z"), "—");
  assert.equal(formatDate("2026-09-13T12:00:00Z"), "13.09");
});

// -- statistics by day --------------------------------------------------------

test("usageByDay groups records by UTC day, newest first", () => {
  const days = usageByDay({
    items: [
      { created_at: "2026-09-13T10:00:00+00:00", tokens_in: 100, tokens_out: 10, cost_usd: 0.01 },
      { created_at: "2026-09-13T18:00:00+00:00", tokens_in: 200, tokens_out: 20, cost_usd: 0.02 },
      { created_at: "2026-09-12T09:00:00+00:00", tokens_in: 50, tokens_out: 5, cost_usd: 0.005 },
    ],
  });

  assert.deepEqual(days.map((day) => day.date), ["2026-09-13", "2026-09-12"]);
  assert.equal(days[0].digests, 2);
  assert.equal(days[0].tokensIn, 300);
  assert.equal(days[0].tokensOut, 30);
  assert.equal(days[0].costUsd, 0.03);
  assert.equal(days[1].digests, 1);
});

test("usageByDay counts cache hits too", () => {
  const days = usageByDay({
    items: [{ created_at: "2026-09-13T10:00:00+00:00", cache_hit_tokens: 700 }],
  });
  assert.equal(days[0].cacheHitTokens, 700);
});

test("usageByDay tolerates a missing or empty file", () => {
  assert.deepEqual(usageByDay(null), []);
  assert.deepEqual(usageByDay({}), []);
  assert.deepEqual(usageByDay({ items: [{ tokens_in: 5 }] }), []); // no timestamp
});

// -- digest presentation ------------------------------------------------------

test("briefTopics keeps only the first bullets of each topic", () => {
  const topics = [
    { title: "Тарифы", bullets: ["a", "b", "c", "d"] },
    { title: "Логистика", bullets: ["e"] },
  ];
  assert.deepEqual(briefTopics(topics), [
    { title: "Тарифы", bullets: ["a", "b"] },
    { title: "Логистика", bullets: ["e"] },
  ]);
});

test("briefTopics can be told how many bullets to keep", () => {
  assert.deepEqual(briefTopics([{ title: "X", bullets: ["a", "b", "c"] }], 1), [
    { title: "X", bullets: ["a"] },
  ]);
});

test("briefTopics handles nothing at all", () => {
  assert.deepEqual(briefTopics(null), []);
  assert.deepEqual(briefTopics([{ title: "X" }]), [{ title: "X", bullets: [] }]);
});

test("digestFileName is safe and keeps the channel name", () => {
  const name = digestFileName({ id: "20260913T120000Z-c1", channel_title: "Мой канал / тест" });
  assert.equal(name, "20260913T120000Z-c1-Мой-канал-тест.md");
});

test("digestFileName survives a hostile channel title", () => {
  const name = digestFileName({ id: "x", channel_title: "../../etc/passwd <script>" });
  assert.ok(!name.includes("/"));
  assert.ok(!name.includes("<"));
  assert.ok(name.endsWith(".md"));
});

test("digestFileName falls back when the digest is empty", () => {
  assert.equal(digestFileName(null), "digest-digest.md");
});
