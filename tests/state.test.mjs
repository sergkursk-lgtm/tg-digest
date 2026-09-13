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
  dialogToChannel,
  digestFileName,
  formatDate,
  formatMoment,
  formatTokens,
  formatUsd,
  isNewerThan,
  isSetupComplete,
  secretsFromSetupRun,
  monthKey,
  optionalSteps,
  nextStepId,
  pendingSteps,
  selectableDialogs,
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


// -- the chat directory -------------------------------------------------------

test("a forum chat becomes a forum channel", () => {
  const picked = dialogToChannel({
    id: -1002424956693,
    title: "SOUEAST S07 клуб",
    type: "forum",
    username: null,
    is_forum: true,
  });
  assert.deepEqual(picked, {
    title: "SOUEAST S07 клуб",
    tg_id: "-1002424956693",
    username: "",
    type: "forum",
    has_topics: true,
  });
});

test("a telegram id stays a string, because it exceeds 2^53", () => {
  const picked = dialogToChannel({ id: -1002424956693, title: "x", type: "channel" });
  assert.equal(typeof picked.tg_id, "string");
  assert.equal(picked.tg_id, "-1002424956693");
});

test("a forum flag alone is enough to mean topics", () => {
  const picked = dialogToChannel({ id: 1, title: "x", type: "group", is_forum: true });
  assert.equal(picked.has_topics, true);
  assert.equal(picked.type, "group");
});

test("dialogToChannel survives an empty entry", () => {
  assert.deepEqual(dialogToChannel(null), {
    title: "",
    tg_id: "",
    username: "",
    type: "channel",
    has_topics: false,
  });
});

test("only chats worth summarising are offered", () => {
  const items = [
    { id: 777000, title: "Telegram", type: "user" },
    { id: 1, title: "Личный чат", type: "user" },
    { id: 2, title: "Клуб", type: "forum", is_forum: true },
    { id: 3, title: "  ", type: "channel" },
    { id: 4, title: "Канал", type: "channel" },
  ];
  assert.deepEqual(
    selectableDialogs(items).map((item) => item.id),
    [2, 4],
  );
});

test("selectableDialogs tolerates nothing at all", () => {
  assert.deepEqual(selectableDialogs(null), []);
  assert.deepEqual(selectableDialogs([]), []);
});

// -- secrets the page cannot list ---------------------------------------------

test("a setup-check record tells the page which secrets exist", () => {
  const record = {
    steps: [
      { name: "secret DEEPSEEK_API_KEY", status: "ok", detail: "set, 35 chars" },
      { name: "secret TG_STRING_SESSION", status: "ok", detail: "set, 353 chars" },
      { name: "secret TG_PHONE", status: "fail", detail: "missing" },
      { name: "storage: write access", status: "ok", detail: "written" },
    ],
  };
  const found = secretsFromSetupRun(record);
  assert.ok(found.has("DEEPSEEK_API_KEY"));
  assert.ok(found.has("TG_STRING_SESSION"));
  assert.equal(found.has("TG_PHONE"), false);
  assert.deepEqual([...secretsFromSetupRun(null)], []);
});

test("a token without Secrets: read does not make configured steps look missing", () => {
  // This is the live situation: the PAT can write secrets but the list endpoint answers
  // 500, so `secretNames` is empty. The setup check ran with the secrets in its
  // environment, and its record must be what the checklist trusts.
  const checked = snapshot({
    login: { step: "authorized", phone: "+70000000000" },
    setupRun: {
      status: "ok",
      steps: [
        { name: "secret DEEPSEEK_API_KEY", status: "ok" },
        { name: "secret TG_STRING_SESSION", status: "ok" },
      ],
    },
    channels: [{ id: 1, title: "Клуб" }],
  });
  const steps = setupSteps(checked, []);
  assert.equal(step(steps, "deepseek").done, true);
  assert.equal(step(steps, "telegram-app").done, true);
  // Nothing is left blocking, so the app opens instead of nagging.
  assert.deepEqual(pendingSteps(steps), []);

  // Without that record the same snapshot honestly reports the credentials as unknown.
  const unchecked = setupSteps(snapshot({ login: { step: "authorized" } }), []);
  assert.equal(step(unchecked, "deepseek").done, false);
});

// -- timestamps ---------------------------------------------------------------

test("timestamps are formatted in UTC, wherever the reader is", () => {
  // The backend writes UTC everywhere (digest periods, run records, the tariff clock), so
  // the UI must not render the same moment differently depending on the browser's zone.
  assert.equal(formatMoment("2026-09-13T08:40:41+00:00"), "13.09, 08:40");
  assert.equal(formatDate("2026-09-13T08:40:41+00:00"), "13.09");
  assert.equal(formatMoment("2026-09-13T23:30:00+00:00"), "13.09, 23:30");
  assert.equal(formatMoment(null), "—");
  assert.equal(formatMoment("не дата"), "—");
});

test("a question is not counted as a digest", () => {
  // The backend bills both, and counts them apart: the dashboard must not claim more
  // digests than exist because a question was asked.
  const usage = {
    totals: { digests: 2, questions: 1, tokens_in: 300, tokens_out: 100, cost_usd: 0.004 },
    items: [
      { digest_id: "20260913T084041Z-c1", created_at: "2026-09-13T08:40:41+00:00", tokens_in: 100, tokens_out: 50, cost_usd: 0.002 },
      { digest_id: "ask:20260913T095414Z-q1k7n", created_at: "2026-09-13T09:54:14+00:00", tokens_in: 100, tokens_out: 20, cost_usd: 0.001 },
    ],
  };
  const summary = usageSummary(usage, { values: { budget: { monthly_usd: 5 } } });
  assert.equal(summary.digests, 2);
  assert.equal(summary.questions, 1);

  const [day] = usageByDay(usage);
  assert.equal(day.digests, 1);
  assert.equal(day.questions, 1);
  assert.equal(day.costUsd, 0.003);
});

test("a month written before questions existed still reads", () => {
  // Older usage files have no `questions` field at all.
  const summary = usageSummary({ totals: { digests: 1, cost_usd: 0.001 } }, null);
  assert.equal(summary.questions, 0);
  assert.equal(summary.digests, 1);
});
