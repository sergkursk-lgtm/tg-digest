/**
 * Tests for Telegram delivery from the browser.
 *
 * Telegram rejects a message that is too long or whose markup is unbalanced, and both
 * failures lose part of a digest silently. These tests hold the mirror of the backend
 * splitter to the same rules.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TELEGRAM_MESSAGE_LIMIT,
  TelegramSendError,
  hardSplit,
  sendToBot,
  splitForTelegram,
  stripTags,
} from "../frontend/assets/telegram.js";

const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>/g;

/** Fail when tags are not properly nested and closed. */
function assertBalanced(markup) {
  const stack = [];
  TAG_RE.lastIndex = 0;
  let match;
  while ((match = TAG_RE.exec(markup)) !== null) {
    const tag = match[0];
    const name = match[1];
    if (tag.startsWith("</")) {
      assert.ok(stack.length, `closing </${name}> with nothing open in ${markup}`);
      assert.equal(stack.pop(), name, `mismatched </${name}> in ${markup}`);
    } else {
      stack.push(name);
    }
  }
  assert.deepEqual(stack, [], `unclosed tags in ${markup}`);
}

// -- splitting ----------------------------------------------------------------

test("a short digest is one message", () => {
  assert.deepEqual(splitForTelegram("<b>коротко</b>"), ["<b>коротко</b>"]);
});

test("empty input produces no messages", () => {
  assert.deepEqual(splitForTelegram(""), []);
  assert.deepEqual(splitForTelegram(null), []);
});

test("a long digest is split within the limit and stays balanced", () => {
  const bullets = Array.from({ length: 400 }, (_, index) => `• Пункт номер ${index} с текстом`).join("\n");
  const chunks = splitForTelegram(`<b>Дайджест</b>\n${bullets}`, 1000);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1000, `chunk of ${chunk.length} characters`);
    assertBalanced(chunk);
  }
});

test("open tags are closed and reopened across chunks", () => {
  const body = Array.from({ length: 200 }, () => "• строка про тарифы и сроки").join("\n");
  const chunks = splitForTelegram(`<b>Заголовок\n${body}\nконец</b>`, 600);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.match(chunk, /<b>/);
    assert.match(chunk, /<\/b>/);
    assert.ok(chunk.length <= 600);
  }
});

test("splitting never loses text", () => {
  const markup = `<b>Заголовок</b>\n${Array.from({ length: 300 }, (_, index) => `• пункт ${index}`).join("\n")}`;
  const joined = splitForTelegram(markup, 400).join("");
  for (let index = 0; index < 300; index += 1) {
    assert.ok(joined.includes(`пункт ${index}`), `пункт ${index} went missing`);
  }
});

test("a cut never glues two words together", () => {
  const markup = Array.from({ length: 500 }, (_, index) => `слово${index}`).join(" ");
  const joined = splitForTelegram(markup, 300).map((chunk) => chunk.trim()).join(" ");
  for (let index = 1; index < 500; index += 1) {
    assert.ok(joined.includes(`слово${index - 1} слово${index}`), `broke between ${index - 1} and ${index}`);
  }
});

test("one enormous text run is hard-split", () => {
  const chunks = splitForTelegram("слово ".repeat(2000), 500);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 500);
  }
});

test("hardSplit keeps every character", () => {
  const source = "abcdefghij ".repeat(20).trim();
  assert.equal(hardSplit(source, 15).join(""), source);
});

test("the default limit matches Telegram's", () => {
  assert.equal(TELEGRAM_MESSAGE_LIMIT, 4096);
});

test("stripTags decodes the entities our renderer emits", () => {
  assert.equal(stripTags("<b>a &amp; b</b> &lt;x&gt;"), "a & b <x>");
});

// -- sending ------------------------------------------------------------------

/** A fake Bot API that answers scripted responses. */
function fakeBot(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      const scripted = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return {
        status: scripted.status ?? 200,
        json: async () => scripted.body,
      };
    },
  };
}

test("a short digest is sent in one message", async () => {
  const bot = fakeBot([{ body: { ok: true, result: { message_id: 7 } } }]);
  const ids = await sendToBot({
    token: "1:a",
    chatId: "42",
    markup: "<b>тест</b>",
    fetchImpl: bot.fetchImpl,
  });

  assert.deepEqual(ids, [7]);
  assert.equal(bot.calls.length, 1);
  assert.match(bot.calls[0].url, /\/bot1:a\/sendMessage$/);
  assert.equal(bot.calls[0].body.text, "<b>тест</b>");
  assert.equal(bot.calls[0].body.parse_mode, "HTML");
  assert.deepEqual(bot.calls[0].body.link_preview_options, { is_disabled: true });
});

test("a long digest is sent as several messages", async () => {
  const bot = fakeBot([{ body: { ok: true, result: { message_id: 1 } } }]);
  const markup = `<b>Дайджест</b>\n${"• строка текста\n".repeat(600)}`;
  const ids = await sendToBot({ token: "1:a", chatId: 42, markup, fetchImpl: bot.fetchImpl });

  assert.ok(ids.length > 1);
  assert.equal(bot.calls.length, ids.length);
  for (const call of bot.calls) {
    assert.ok(call.body.text.length <= TELEGRAM_MESSAGE_LIMIT);
    assertBalanced(call.body.text);
  }
});

test("rejected markup is resent as plain text", async () => {
  const bot = fakeBot([
    { status: 400, body: { ok: false, description: "Bad Request: can't parse entities" } },
    { body: { ok: true, result: { message_id: 9 } } },
  ]);
  const ids = await sendToBot({ token: "1:a", chatId: 42, markup: "<b>жирный</b>", fetchImpl: bot.fetchImpl });

  assert.deepEqual(ids, [9]);
  assert.equal(bot.calls.length, 2);
  assert.equal(bot.calls[1].body.text, "жирный");
  assert.equal(bot.calls[1].body.parse_mode, undefined);
});

test("other refusals are reported verbatim", async () => {
  const bot = fakeBot([{ status: 400, body: { ok: false, description: "Bad Request: chat not found" } }]);
  await assert.rejects(
    () => sendToBot({ token: "1:a", chatId: 42, markup: "x", fetchImpl: bot.fetchImpl }),
    (error) => {
      assert.ok(error instanceof TelegramSendError);
      assert.match(error.message, /chat not found/);
      return true;
    },
  );
});

test("a missing token or chat id is refused before any request", async () => {
  const bot = fakeBot([{ body: { ok: true, result: { message_id: 1 } } }]);
  await assert.rejects(
    () => sendToBot({ token: "", chatId: 42, markup: "x", fetchImpl: bot.fetchImpl }),
    /токен бота/,
  );
  await assert.rejects(
    () => sendToBot({ token: "1:a", chatId: "  ", markup: "x", fetchImpl: bot.fetchImpl }),
    /chat_id/,
  );
  assert.equal(bot.calls.length, 0);
});

test("an empty digest is refused", async () => {
  const bot = fakeBot([{ body: { ok: true, result: { message_id: 1 } } }]);
  await assert.rejects(
    () => sendToBot({ token: "1:a", chatId: 42, markup: "", fetchImpl: bot.fetchImpl }),
    /отправлять нечего/,
  );
});
