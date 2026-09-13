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

test("a digest row can be swiped to reveal Delete", async () => {
  const { createDigestsScreen } = await load("screen-digests.js");
  const screen = createDigestsScreen(context());

  const wrappers = all(screen.node, (child) => child.classList?.contains("swipe"));
  assert.equal(wrappers.length, 1, "each digest gets a swipable row");

  const action = all(screen.node, (child) => child.classList?.contains("swipe__delete"));
  assert.equal(action.length, 1);
  assert.match(textOf(action[0]), /Удалить/);
  // A screen reader needs a name that says which digest is being deleted.
  assert.match(action[0].getAttribute("aria-label"), /Удалить дайджест/);

  // The row itself is still the tap target that opens the digest.
  const content = all(screen.node, (child) => child.classList?.contains("swipe__content"));
  assert.equal(content.length, 1);
  assert.equal(content[0].tagName, "BUTTON");
});

test("an empty project is offered the one useful action", async () => {
  const { createDigestsScreen } = await load("screen-digests.js");
  const empty = createDigestsScreen(context({ snapshot: snapshot({ digests: [], channels: [] }) }));
  assert.match(textOf(empty.node), /Дайджестов пока нет/);
  assert.equal(empty.floating, null, "nothing to collect from");
});

test("an answer is one bubble, with no list of messages under it", async () => {
  const { askBubble } = await load("screen-digests.js");

  const mine = askBubble({ role: "me", text: "что там про руль?" });
  assert.equal(mine.className, "bubble bubble--mine");
  assert.equal(mine.textContent, "что там про руль?");

  const theirs = askBubble({ role: "ai", text: "Калибровка помогла." });
  assert.equal(theirs.className, "bubble bubble--theirs");
  // Nothing follows the answer: no links, no second element.
  assert.equal(theirs.children.length, 0);
  assert.equal(all(theirs, (child) => child.tagName === "A").length, 0);

  // Even an entry saved by an older version, which carried `refs`, renders as one bubble.
  const legacy = askBubble({ role: "ai", text: "Ответ", refs: [{ link: "https://t.me/c/1/2" }] });
  assert.equal(legacy.textContent, "Ответ");
  assert.equal(all(legacy, (child) => child.tagName === "A").length, 0);
});

test("no styles are left for the removed message list", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../frontend/assets/design.css", import.meta.url), "utf8");
  assert.ok(!/\.refs\b/.test(css), "the .refs rules should be gone");
  assert.ok(!/\.bubble-group\b/.test(css), "the .bubble-group rules should be gone");
});

test("opening a digest renders the brief view and the ask box", async () => {
  const { createDigestDetail } = await load("screen-digests.js");
  const digest = {
    id: "20260913T084041Z-c1",
    channel_title: "Клуб",
    period_start: NOW,
    period_end: NOW,
    topics: [{ title: "Руль", bullets: ["калибровка помогла", "сход-развал тоже"] }],
    html: "<h2>Руль</h2>",
    markdown: "# Руль",
    telegram_html: "<b>Руль</b>",
    usage: { tokens_in: 100, tokens_out: 20, cost_usd: 0.001 },
  };
  const client = { readJson: async () => ({ data: digest, sha: "a".repeat(40) }) };

  const screen = createDigestDetail(context({ client }), digest.id);
  assert.equal(screen.back, true);
  // The article is read asynchronously; let it settle.
  await new Promise((done) => setTimeout(done, 0));

  const text = textOf(screen.node);
  assert.match(text, /SOUEAST|Клуб/);
  assert.match(text, /калибровка помогла/);
  assert.match(text, /Спросить у ИИ/);
  assert.match(text, /Скачать \.md/);

  // The digest is for reading. Token counts and cost are not shown here — the money is
  // accounted for in settings.
  for (const absent of ["токенов на вход", "на выход", "$"]) {
    assert.ok(!text.includes(absent), `the digest should not mention "${absent}"`);
  }
});

// -- channels ------------------------------------------------------------------

test("the channel list marks the selected chats and hides private ones", async () => {
  const { createChannelsScreen } = await load("screen-channels.js");
  const { node } = createChannelsScreen(context());
  const text = textOf(node);

  assert.match(text, /Клуб/);
  assert.match(text, /Военная сводка/);
  // A digest is not for private conversations or Telegram's own service chat.
  assert.ok(!text.includes("Личный чат"));
  assert.ok(!/Telegram\b/.test(text.replace("Telegram-канал", "")));

  const pressed = all(node, (child) => child.getAttribute?.("aria-pressed") === "true");
  assert.equal(pressed.length, 1, "only the configured channel is on");
  assert.match(textOf(pressed[0]), /Клуб/);
});

test("channels are grouped by kind", async () => {
  const { createChannelsScreen } = await load("screen-channels.js");
  const { node } = createChannelsScreen(context());
  const headings = all(node, (child) => child.tagName === "H3").map((child) => textOf(child));
  assert.ok(headings.includes("Форумы"));
  assert.ok(headings.includes("Каналы"));
});

// -- settings ------------------------------------------------------------------

test("settings shows one section per concern, with secrets kept out of sight", async () => {
  const { createSettingsScreen } = await load("screen-settings.js");
  const { node } = createSettingsScreen(context());
  const text = textOf(node);

  for (const section of ["Статус", "Аккаунт Telegram", "DeepSeek", "Приложение в Telegram", "Оформление", "Опасное"]) {
    assert.ok(text.includes(section), `missing the "${section}" section`);
  }

  // No money management in the interface: the ceiling and the rate limits stay in
  // data/settings.json and are enforced by the backend, but nothing here edits them.
  for (const absent of ["Бюджет на месяц", "Лимиты запусков", "Предел, $ в месяц", "Дайджестов в сутки"]) {
    assert.ok(!text.includes(absent), `"${absent}" should not be in settings`);
  }

  // The bot token is never rendered as text, only into a password field.
  assert.ok(!text.includes("123456:secret-token"), "the bot token must not appear in the markup");
  const password = all(node, (child) => child.getAttribute?.("type") === "password");
  assert.ok(password.length >= 2, "the token and the DeepSeek key are password fields");

  // Templates and statistics are collapsed, not competing for the root.
  const details = all(node, (child) => child.tagName === "DETAILS");
  assert.equal(details.length, 2);
});

test("nothing in settings sends anything to Telegram", async () => {
  const { createSettingsScreen } = await load("screen-settings.js");
  const { node } = createSettingsScreen(context());
  const text = textOf(node);

  // The bot is the entrance to the app, not a delivery channel.
  assert.match(text, /Бот нужен как вход/);
  assert.match(text, /Показать кнопку в боте/);
  assert.ok(!text.includes("Отправляю тестовое сообщение"));

  // The send path is gone from the source entirely.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../frontend/assets/screen-settings.js", import.meta.url),
    "utf8",
  );
  assert.ok(!source.includes("sendMessage"), "settings must not send messages");
});

test("questions appear in the statistics only once there are some", async () => {
  const { createSettingsScreen } = await load("screen-settings.js");
  const withQuestions = textOf(createSettingsScreen(context()).node);
  assert.match(withQuestions, /Вопросов к ИИ/);

  const without = textOf(
    createSettingsScreen(
      context({ snapshot: snapshot({ usage: { totals: { digests: 1, cost_usd: 0.001 } } }) }),
    ).node,
  );
  assert.ok(!without.includes("Вопросов к ИИ"));
  // An older usage file simply has no questions field.
  assert.match(without, /Дайджестов/);
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
