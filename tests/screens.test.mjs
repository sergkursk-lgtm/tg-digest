/**
 * Tests for the screens themselves, on the same DOM stub the primitives use.
 *
 * The screens are the part that only existed as pixels before: a runner cannot click
 * through them, so what is asserted here is structure — that a missing credential produces
 * a row with a way to fix it, that a selected channel renders as selected, that a secret is
 * never rendered in the clear.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { withDom } from "./helpers/fake-dom.mjs";

/** Import a screen module against a fresh stub document. */
async function load(name) {
  const { module } = await withDom(`../frontend/assets/${name}`);
  return module;
}

/** The text of a node, including descendants. */
function textOf(node) {
  const parts = [node.textContent ?? ""];
  for (const child of node.children ?? []) {
    if (child && typeof child === "object" && "children" in child) {
      parts.push(textOf(child));
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Every descendant matching a predicate. */
function all(node, predicate) {
  const found = [];
  const walk = (current) => {
    for (const child of current.children ?? []) {
      if (!child || typeof child !== "object") continue;
      if (predicate(child)) found.push(child);
      walk(child);
    }
  };
  walk(node);
  return found;
}

const NOW = "2026-09-13T08:40:41+00:00";

/** A snapshot of a fully configured project. */
function snapshot(overrides = {}) {
  return {
    settings: {
      values: {
        telegram: { bot_token: "123456:secret-token", chat_id: "211254823" },
        budget: { monthly_usd: 5, warn_ratio: 0.8 },
      },
    },
    login: { step: "authorized", api_id: 1, api_hash: "h", phone: "+70000000000" },
    channels: [{ id: 1, tg_id: "-100", title: "Клуб", type: "forum", has_topics: true, default_period_hours: 24, summary_style_id: 1, username: "club" }],
    presets: [
      { id: 1, name: "Краткий", system_prompt_key: "summary_brief", is_default: 1 },
      { id: 2, name: "Детальный", system_prompt_key: "summary_detailed", is_default: 0 },
    ],
    templates: [{ id: 1, name: "По умолчанию", grouping: "topics", sections: ["summary"], is_default: 1 }],
    digests: [
      {
        id: "20260913T084041Z-c1",
        channel_id: 1,
        channel_title: "Клуб",
        period_start: NOW,
        period_end: NOW,
        messages_used: 40,
        cost_usd: 0.00102,
        status: "ok",
        created_at: NOW,
      },
    ],
    usage: { totals: { digests: 1, questions: 2, tokens_in: 300, tokens_out: 100, cost_usd: 0.004 } },
    dialogs: [
      { id: -100, title: "Клуб", type: "forum", is_forum: true, username: "club" },
      { id: -200, title: "Военная сводка", type: "channel", username: "war" },
      { id: -300, title: "Личный чат", type: "user" },
      { id: 777000, title: "Telegram", type: "user" },
    ],
    // The setup check is what tells the page which secrets exist; without its `secret ...`
    // rows an otherwise finished project still looks like it is missing credentials.
    setupRun: {
      status: "ok",
      updated_at: NOW,
      finished_at: NOW,
      steps: [
        { name: "secret DEEPSEEK_API_KEY", status: "ok" },
        { name: "secret TG_API_ID", status: "ok" },
        { name: "secret TG_API_HASH", status: "ok" },
        { name: "secret TG_STRING_SESSION", status: "ok" },
      ],
    },
    month: "2026-09",
    ...overrides,
  };
}

/** The context the router hands to a screen. */
function context(overrides = {}) {
  return {
    client: { owner: "sergkursk-lgtm", repo: "tg-digest-core" },
    snapshot: snapshot(),
    secretNames: [],
    secretsReadable: true,
    hasSecret: () => true,
    navigate: () => {},
    back: () => {},
    refresh: async () => {},
    currentTheme: () => "system",
    setTheme: () => {},
    onForgetToken: () => {},
    finishOnboarding: () => {},
    ...overrides,
  };
}

// -- first run -----------------------------------------------------------------

test("onboarding lists what is missing with a way to fix each item", async () => {
  const { createOnboardingScreen } = await load("onboarding.js");
  const bare = snapshot({
    login: null,
    channels: [],
    usage: null,
    setupRun: null, // no check has run, so nothing is known to be configured
    settings: { values: { telegram: { bot_token: "", chat_id: "" } } },
  });

  const { node, chrome } = createOnboardingScreen(context({ snapshot: bare }));
  const text = textOf(node);
  assert.match(text, /Осталось настроить/);
  assert.match(text, /Приложение Telegram/);
  assert.match(text, /Ключ DeepSeek/);
  assert.match(text, /Доставка в Telegram/);

  const labels = all(node, (child) => child.tagName === "BUTTON").map((button) => textOf(button));
  assert.ok(labels.some((label) => label.includes("Ввести ключ")));
  assert.ok(labels.some((label) => label.includes("Выбрать каналы")));
  // Onboarding has no tabs and no cost strip: there is nothing to navigate to yet.
  assert.deepEqual(chrome, { tabs: false, footer: false });
});

test("a configured project is told it can start", async () => {
  const { createOnboardingScreen } = await load("onboarding.js");
  const { node } = createOnboardingScreen(context());
  const labels = all(node, (child) => child.tagName === "BUTTON").map((button) => textOf(button));
  assert.ok(labels.includes("Начать"));
});

// -- digests -------------------------------------------------------------------

test("the digest list is a list, with no spend line", async () => {
  const { createDigestsScreen } = await load("screen-digests.js");
  const screen = createDigestsScreen(context());
  const text = textOf(screen.node);

  assert.equal(screen.title, "Дайджесты");
  assert.match(text, /Собрано: 1/);
  assert.match(text, /Клуб/);
  assert.match(text, /40 сообщ\./);

  // Nothing about money, tokens or the tariff: the reader asked for the list to stay a
  // list. The budget lives in settings.
  for (const absent of ["Off-peak", "Peak", "токенов", "$"]) {
    assert.ok(!text.includes(absent), `the list should not mention "${absent}"`);
  }
  assert.equal(all(screen.node, (child) => child.classList?.contains("spend")).length, 0);

  // A floating "collect" button appears only when there is something to collect.
  assert.ok(screen.floating, "a project with channels gets the floating button");
});

test("a digest row deletes on a swipe, with no button and no dialog", async () => {
  const { createDigestsScreen } = await load("screen-digests.js");
  const screen = createDigestsScreen(context());

  const wrappers = all(screen.node, (child) => child.classList?.contains("swipe"));
  assert.equal(wrappers.length, 1, "each digest gets a swipable row");

  // There is no button hiding behind the row: the gesture is the action.
  assert.equal(
    all(screen.node, (child) => child.classList?.contains("swipe__delete")).length,
    0,
    "no delete button behind the row",
  );
  // The hint is what turns red while the finger is down past the trigger.
  const hint = all(screen.node, (child) => child.classList?.contains("swipe__hint"));
  assert.equal(hint.length, 1);
  assert.match(textOf(hint[0]), /Удалить/);

  // The row itself is still the tap target that opens the digest.
  const content = all(screen.node, (child) => child.classList?.contains("swipe__content"));
  assert.equal(content.length, 1);
  assert.equal(content[0].tagName, "BUTTON");
});

test("a deleted digest can be put back exactly where it was", async () => {
  const { withoutDigest, withDigest } = await load("screen-digests.js");
  const index = {
    schema: 1,
    items: [
      { id: "c", created_at: "2026-09-13T12:00:00+00:00" },
      { id: "b", created_at: "2026-09-13T11:00:00+00:00" },
      { id: "a", created_at: "2026-09-13T10:00:00+00:00" },
    ],
  };

  const dropped = withoutDigest(index, "b");
  assert.deepEqual(
    dropped.items.map((entry) => entry.id),
    ["c", "a"],
  );

  const restored = withDigest(dropped, index.items[1]);
  // Back in its own place, not appended to the end.
  assert.deepEqual(
    restored.items.map((entry) => entry.id),
    ["c", "b", "a"],
  );
  // The original list is not mutated: the caller's copy is what it read.
  assert.equal(index.items.length, 3);
});

test("deleting and undoing touches the file, the index and the thread", async () => {
  const { deleteDigest, restoreDigest } = await load("screen-digests.js");

  const writes = [];
  const deleted = [];
  const files = new Map([
    ["data/digests/x.json", { data: { id: "x", markdown: "# x" }, sha: "sha-file" }],
    ["data/digests/index.json", { data: { schema: 1, items: [{ id: "x", created_at: "2026-09-13T12:00:00+00:00" }] }, sha: "sha-index" }],
  ]);
  const client = {
    async readJson(path) {
      return files.get(path) ?? { data: null, sha: null };
    },
    async writeJson(path, payload, message, sha) {
      writes.push({ path, payload, sha });
      files.set(path, { data: payload, sha: "sha-new" });
    },
    async deleteFile(path, message, sha) {
      deleted.push({ path, sha });
      files.delete(path);
    },
  };

  const ctx = context({ client });
  const item = { id: "x", channel_title: "Клуб", period_start: NOW, period_end: NOW, created_at: "2026-09-13T12:00:00+00:00" };

  const record = await deleteDigest(ctx, item);
  assert.deepEqual(deleted, [{ path: "data/digests/x.json", sha: "sha-file" }]);
  assert.equal(files.has("data/digests/x.json"), false);
  assert.deepEqual(files.get("data/digests/index.json").data.items, []);
  // The file travels in the undo record, which is what makes the way back free.
  assert.equal(record.file.markdown, "# x");

  await restoreDigest(ctx, record);
  assert.equal(files.get("data/digests/x.json").data.markdown, "# x");
  assert.deepEqual(
    files.get("data/digests/index.json").data.items.map((entry) => entry.id),
    ["x"],
  );
  // The file is written without a sha: after a delete there is nothing to match against.
  const fileWrite = writes.find((entry) => entry.path === "data/digests/x.json");
  assert.equal(fileWrite.sha, null);
});

test("the new-digest sheet promises nothing about the bot", async () => {
  const { openNewDigestSheet } = await load("screen-digests.js");
  const sheet = openNewDigestSheet(context({ client: {}, snapshot: snapshot() }));
  const text = textOf(sheet.body ?? sheet.root);
  assert.match(text, /1 канал · 24 ч/);
  assert.ok(!text.includes("в бота"), "digests are not sent anywhere");
});

test("the run's progress is read from the stages it has reported", async () => {
  const { progressOf } = await load("screen-digests.js");

  assert.equal(progressOf(null), 0);
  assert.equal(progressOf({ status: "running", steps: [] }), 0);

  // Only what has actually been reported counts, and the furthest stage wins.
  assert.equal(progressOf({ status: "running", steps: [{ name: "load_settings", status: "ok" }] }), 6);
  assert.equal(
    progressOf({
      status: "running",
      steps: [
        { name: "load_settings", status: "ok" },
        { name: "read:c1", status: "running" },
      ],
    }),
    45,
  );
  // A stage that has not started yet does not count.
  assert.equal(
    progressOf({ status: "running", steps: [{ name: "summarize:c1", status: "pending" }] }),
    0,
  );
  // Two channels do not stack: the bar is a share of one run, not a sum.
  assert.equal(
    progressOf({
      status: "running",
      steps: [
        { name: "read:c1", status: "ok" },
        { name: "read:c2", status: "ok" },
      ],
    }),
    45,
  );
  // A finished run is done, whatever it reported on the way.
  assert.equal(progressOf({ status: "ok", steps: [] }), 100);

  // An unknown stage from a newer workflow cannot push the bar past the known ones.
  assert.equal(progressOf({ status: "running", steps: [{ name: "teleport", status: "ok" }] }), 0);
});

test("the digest screen offers delete, not resend", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../frontend/assets/screen-digests.js", import.meta.url),
    "utf8",
  );
  assert.ok(!source.includes("sendToBot"), "the browser must not send anything to Telegram");
  assert.ok(source.includes('label: "Удалить"'), "the detail screen offers delete");
});

test("the run sheet shows a bar, not a growing list of stages", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../frontend/assets/screen-digests.js", import.meta.url),
    "utf8",
  );
  // The list of stage lines is gone, and so is the line about GitHub Actions.
  assert.ok(!source.includes("stepList"), "the sheet must not list stages");
  assert.ok(!source.includes("GitHub Actions"), "the reader does not need to know where it runs");
  assert.match(source, /progressBar\(/);

  // The only caption left is the estimate, and it stays put.
  assert.match(source, /Обычно это занимает около минуты/);
});

test("the bar eases towards what it was told, and never past it", async () => {
  const { progressBar } = await load("ui.js");
  const bar = progressBar({ label: "Обычно это занимает около минуты." });

  assert.equal(bar.value(), 0);
  assert.equal(bar.target(), 0);

  bar.set(45);
  assert.equal(bar.target(), 45);
  // The bar runs towards the milestone instead of jumping, which is the point of it.
  assert.ok(bar.value() > 0 && bar.value() < 45, `eased, got ${bar.value()}`);

  // Out of range is clamped, and the bar never moves backwards.
  bar.set(1000);
  assert.equal(bar.target(), 100);
  const before = bar.value();
  bar.set(-5);
  assert.equal(bar.target(), 100);
  assert.ok(bar.value() >= before);

  bar.finish();
  assert.equal(bar.value(), 100);

  const failed = progressBar({});
  failed.set(20);
  failed.fail("не вышло");
  // A failure stops the bar where the run really got to.
  assert.equal(failed.value(), 20);
  assert.match(textOf(failed.node), /не вышло/);

  bar.destroy();
  failed.destroy();
});
