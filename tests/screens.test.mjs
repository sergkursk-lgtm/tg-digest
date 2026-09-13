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
    templates: [
      { id: 1, name: "По умолчанию", grouping: "topics", sections: ["summary"], is_default: 1 },
      { id: 2, name: "По дням", grouping: "dates", sections: ["summary"], is_default: 0 },
    ],
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
        preset_name: "Аналитический",
        created_at: NOW,
      },
    ],
    usage: {
      totals: { digests: 1, questions: 2, tokens_in: 300, tokens_out: 100, cost_usd: 0.004 },
      // One day, so the day-by-day table is rendered rather than skipped.
      items: [
        { digest_id: "d1", created_at: NOW, tokens_in: 300, tokens_out: 100, cost_usd: 0.004 },
      ],
    },
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

  // The one number that matters sits on the dark panel, the way the reference does it.
  const hero = all(screen.node, (child) => child.classList?.contains("hero"))[0];
  assert.ok(hero, "the screen opens with a hero panel");
  assert.match(textOf(hero), /Собрано дайджестов/);
  assert.match(textOf(hero), /^.*Собрано дайджестов\s*1/s);
  assert.match(textOf(hero), /Аналитический|стиль/);

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

test("the new-digest sheet offers the layouts and promises nothing about the bot", async () => {
  const { openNewDigestSheet } = await load("screen-digests.js");
  const sheet = openNewDigestSheet(context({ client: {}, snapshot: snapshot() }));
  const text = textOf(sheet.body ?? sheet.root);

  assert.match(text, /1 канал · 24 ч · 2 стиля · По умолчанию/);
  assert.ok(!text.includes("в бота"), "digests are not sent anywhere");

  // Every layout is offered, and the default one is selected.
  const chips = all(sheet.body ?? sheet.root, (child) => child.classList?.contains("chip"));
  const labels = chips.map((chip) => textOf(chip));
  assert.ok(labels.includes("По умолчанию"));
  assert.ok(labels.includes("По дням"));
  assert.equal(chips.find((chip) => textOf(chip) === "По умолчанию").classList.contains("chip--on"), true);
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


// -- the digest screen --------------------------------------------------------

/** Open one digest against a fake client and let the read settle. */
async function openDigest(digest) {
  const { createDigestDetail } = await load("screen-digests.js");
  const client = { readJson: async () => ({ data: digest, sha: "a".repeat(40) }) };
  const screen = createDigestDetail(context({ client }), digest.id);
  await new Promise((done) => setTimeout(done, 0));
  return screen;
}

/** One digest holding the same period written three ways. */
const THREE_STYLE_DIGEST = {
  id: "20260913T123109Z-c1",
  channel_title: "SOUEAST S07 клуб",
  period_start: NOW,
  period_end: NOW,
  preset_id: 1,
  preset_name: "Краткий",
  topics: [{ title: "Руль", bullets: ["тезис кратко"] }],
  markdown: "# Руль\n- тезис кратко",
  html: "<h2>Руль</h2><ul><li>тезис кратко</li></ul>",
  variants: [
    {
      preset_id: 1,
      preset_name: "Краткий",
      topics: [{ title: "Руль", bullets: ["тезис кратко"] }],
      markdown: "# Руль",
      html: "<h2>Руль</h2>",
    },
    {
      preset_id: 2,
      preset_name: "Детальный",
      topics: [{ title: "Руль", bullets: ["подробность"] }],
      markdown: "# Руль",
      html: "<h2>Руль</h2>",
    },
    {
      preset_id: 3,
      preset_name: "Аналитический",
      topics: [{ title: "Руль", bullets: ["причина и следствие"] }],
      markdown: "# Руль",
      html: "<h2>Руль</h2>",
    },
  ],
};

const DIGEST = {
  id: "20260913T084041Z-c1",
  channel_title: "SOUEAST S07 клуб",
  period_start: NOW,
  period_end: NOW,
  preset_name: "Аналитический",
  topics: [{ title: "Руль", bullets: ["калибровка помогла", "сход-развал тоже"] }],
  html: "<h2>Руль</h2>",
  markdown: "# Руль",
  telegram_html: "",
  usage: { tokens_in: 100, tokens_out: 20, cost_usd: 0.001 },
};

test("a digest with three styles opens a switcher, not a mystery", async () => {
  // The reader asked "where is the analytical one?" while looking at an analytical digest:
  // nothing on the screen said so, and the reading toggle was called "Краткий".
  const screen = await openDigest(THREE_STYLE_DIGEST);
  const text = textOf(screen.node);

  // One button per style, the first one on.
  const chips = all(screen.node, (child) => child.classList?.contains("chip"));
  assert.deepEqual(
    chips.map((chip) => textOf(chip)),
    ["Краткий", "Детальный", "Аналитический", "Тезисы", "Весь текст"],
  );
  assert.equal(chips[0].classList.contains("chip--on"), true, "the primary style is open");
  assert.equal(chips[2].classList.contains("chip--on"), false);

  // The caption names the style that is on screen, so the text is never anonymous.
  assert.match(text, /Стиль: Краткий/);
});

test("switching the style shows that style's text", async () => {
  const screen = await openDigest(THREE_STYLE_DIGEST);
  const chips = () => all(screen.node, (child) => child.classList?.contains("chip"));

  assert.match(textOf(screen.node), /тезис кратко/);

  chips().find((chip) => textOf(chip) === "Аналитический").fire("click");

  const text = textOf(screen.node);
  assert.match(text, /причина и следствие/, "the analytical wording is on screen");
  assert.ok(!text.includes("тезис кратко"), "and the brief one is not");
  assert.equal(chips().find((chip) => textOf(chip) === "Аналитический").classList.contains("chip--on"), true);
  assert.match(text, /Стиль: Аналитический/);
});

test("a one-style digest needs no switcher", async () => {
  // A digest built by an older version, or by a manual run with one style.
  const screen = await openDigest(DIGEST);
  const chips = all(screen.node, (child) => child.classList?.contains("chip")).map((chip) =>
    textOf(chip),
  );
  // Only the reading toggle: there is nothing to switch between.
  assert.deepEqual(chips, ["Тезисы", "Весь текст"]);
  assert.match(textOf(screen.node), /Аналитический/);
});

test("the reading toggle switches how much is shown, not which digest it is", async () => {
  const screen = await openDigest(DIGEST);
  const text = () => textOf(screen.node);

  // The default view folds the digest to two bullets per topic and says so.
  assert.match(text(), /По два тезиса на тему/);
  assert.match(text(), /калибровка помогла/);

  const chips = all(screen.node, (child) => child.classList?.contains("chip"));
  assert.equal(textOf(chips[0]), "Тезисы");
  assert.equal(textOf(chips[1]), "Весь текст");
  assert.equal(chips[0].classList.contains("chip--on"), true, "the folded view is the default");
  assert.equal(chips[1].classList.contains("chip--on"), false);

  // Switching to the whole text re-renders the article from the stored HTML. That path runs
  // the sanitiser, which needs a real DOM and has its own tests in sanitize.test.mjs; what is
  // checked here is that the toggle offers it and the view starts folded.
});

test("a digest written before the style was recorded says so", async () => {
  const screen = await openDigest({ ...DIGEST, preset_name: "" });
  // No invented style: the file simply does not say.
  assert.match(textOf(screen.node), /стиль не записан/);
});

test("the list names the style of each digest", async () => {
  const { createDigestsScreen } = await load("screen-digests.js");
  const screen = createDigestsScreen(context());
  const sub = all(screen.node, (child) => child.classList?.contains("list__sub"))[0];
  assert.match(textOf(sub), /Аналитический/);
});


test("the download carries the style it is showing", async () => {
  const { digestFileName } = await load("state.js");
  // A digest holds several versions of the same period; three files with one name in a
  // downloads folder would be a puzzle.
  assert.equal(digestFileName({ id: "d1", channel_title: "Клуб" }, "Аналитический"), "d1-Клуб-Аналитический.md");
  assert.equal(digestFileName({ id: "d1", channel_title: "Клуб" }), "d1-Клуб.md");
});

// -- styles and layouts are editable ------------------------------------------

test("the style and layout lists open editors instead of only describing", async () => {
  const { templatesAccordion } = await load("screen-styles.js");
  const body = templatesAccordion(context());
  const text = textOf(body);

  // The reader could see the styles and could not add one; every layout said "по
  // умолчанию" with no way to choose another.
  assert.match(text, /Свой стиль/);
  assert.match(text, /Свой шаблон/);
  assert.match(text, /Каждый прогон пишет все стили сразу/);
  assert.match(text, /Шаблоны вёрстки/);

  const rows = all(body, (child) => child.classList?.contains("list__row"));
  assert.ok(rows.length >= 3, "the styles and the layouts are listed");
});

test("a layout is described by what it actually does", async () => {
  const { describeTemplate } = await load("screen-styles.js");
  assert.equal(describeTemplate({ grouping: "topics", sections: ["summary"] }), "По темам канала · только сводка");
  assert.equal(describeTemplate({ grouping: "dates", sections: ["summary", "meta"] }), "По дням · сводка и итоги");
  assert.equal(describeTemplate({ grouping: "llm", sections: ["summary"] }), "По темам от модели · только сводка");
  // An unknown grouping from a hand-edited file still describes something.
  assert.match(describeTemplate({ grouping: "mystery", sections: [] }), /mystery/);
});

test("editing the collections keeps them valid", async () => {
  const { nextId, upsert, withoutEntry, withDefault } = await load("screen-styles.js");

  assert.equal(nextId([]), 1);
  assert.equal(nextId([{ id: 3 }, { id: 7 }]), 8);

  const added = upsert([{ id: 1, name: "A" }], { id: 2, name: "B" });
  assert.deepEqual(added.map((item) => item.id), [1, 2]);

  // Exactly one default: marking one clears the others.
  const marked = withDefault([{ id: 1, is_default: 1 }, { id: 2, is_default: 0 }], 2);
  assert.deepEqual(marked.map((item) => item.is_default), [0, 1]);

  // Removing the default promotes the first survivor, so the list never has none.
  const removed = withoutEntry([{ id: 1, is_default: 1 }, { id: 2, is_default: 0 }], 1);
  assert.deepEqual(removed, [{ id: 2, is_default: 1 }]);
});

test("the digest list opens with the dark panel, and rows carry a round icon", async () => {
  const { createDigestsScreen } = await load("screen-digests.js");
  const screen = createDigestsScreen(context());

  const hero = all(screen.node, (child) => child.classList?.contains("hero"))[0];
  assert.ok(hero, "the screen opens with the panel");
  assert.equal(all(hero, (c) => c.classList?.contains("hero__label"))[0].textContent, "Собрано дайджестов");
  assert.equal(all(hero, (c) => c.classList?.contains("hero__value"))[0].textContent, "1");

  // The round tinted badge is what the reference uses to open every row.
  const rows = all(screen.node, (child) => child.classList?.contains("list__row"));
  for (const row of rows) {
    assert.ok(
      all(row, (c) => c.classList?.contains("icon-badge")).length === 1,
      "every row opens with an icon badge",
    );
  }
});

test("the statistics tiles and the table fit a phone", async () => {
  const { createSettingsScreen } = await load("screen-settings.js");
  const screen = createSettingsScreen(context());
  // Every accordion open: the statistics live inside one.
  for (const details of all(screen.node, (c) => c.tagName === "DETAILS")) details.open = true;

  const tiles = all(screen.node, (c) => c.classList?.contains("stat"));
  assert.ok(tiles.length >= 4, "the figures are tiles");
  for (const tile of tiles) {
    assert.ok(all(tile, (c) => c.classList?.contains("stat__label")).length === 1);
    assert.ok(all(tile, (c) => c.classList?.contains("stat__value")).length === 1);
  }

  // The day table used to be 429px of columns in a 309px screen, scrolling sideways.
  const headers = all(screen.node, (c) => c.tagName === "TH").map((th) => textOf(th));
  assert.deepEqual(headers, ["День", "Дайдж.", "Токены", "$"]);
});
