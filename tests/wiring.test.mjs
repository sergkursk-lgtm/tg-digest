/**
 * Tests for the shared helpers and for the wiring of the whole page.
 *
 * The wiring tests matter more than they look: there is no bundler and no build step, so a
 * typo in an import list or in a `getElementById` produces a blank page with the error
 * visible only in the browser console.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  buildChannel,
  mergeBudgetSettings,
  mergeTelegramSettings,
} from "../frontend/assets/backend.js";
import { describeStep } from "../frontend/assets/screen-digests.js";
import { periodLabelFor } from "../frontend/assets/screen-channels.js";
import { channelCount, plural } from "../frontend/assets/ui.js";

const ROOT = new URL("../", import.meta.url);
const ASSETS = [
  "api.js",
  "app.js",
  "backend.js",
  "blake2b.js",
  "bytes.js",
  "crypto.js",
  "dom.js",
  "local.js",
  "lock.js",
  "miniapp.js",
  "onboarding.js",
  "sanitize.js",
  "screen-channels.js",
  "screen-digests.js",
  "screen-settings.js",
  "seal.js",
  "state.js",
  "tariff.js",
  "telegram.js",
  "ui.js",
];

/** Read a frontend asset as text. */
async function readAsset(name) {
  return readFile(new URL(`frontend/assets/${name}`, ROOT), "utf8");
}

/** Extract named imports from a module source. */
function parseImports(source) {
  const imports = [];
  const pattern = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    imports.push({
      specifier: match[2],
      names: match[1]
        .split(",")
        .map((entry) => entry.trim().split(/\s+as\s+/).pop().trim())
        .filter(Boolean),
    });
  }
  return imports;
}

// -- settings merging ---------------------------------------------------------

test("mergeTelegramSettings keeps every other setting", () => {
  const settings = {
    schema: 1,
    updated_at: "2026-09-13T12:00:00+00:00",
    values: {
      budget: { monthly_usd: 7, warn_ratio: 0.5 },
      llm: { model: "deepseek-flash", thinking: "disabled", max_output_tokens: 4096 },
      telegram: { bot_token: "", chat_id: "", max_digests_per_day: 50, max_requests_per_hour: 10 },
      ui: { theme: "system", language: "ru" },
    },
  };
  const merged = mergeTelegramSettings(settings, { bot_token: "1:a", chat_id: "42" });

  assert.equal(merged.values.budget.monthly_usd, 7);
  assert.equal(merged.values.llm.max_output_tokens, 4096);
  assert.equal(merged.values.telegram.bot_token, "1:a");
  assert.equal(merged.values.telegram.chat_id, "42");
  assert.equal(merged.values.telegram.max_digests_per_day, 50); // not lost
  assert.equal(merged.schema, 1);
});

test("mergeTelegramSettings works with no existing settings file", () => {
  const merged = mergeTelegramSettings(null, { bot_token: "1:a", chat_id: "42" });
  assert.equal(merged.values.telegram.bot_token, "1:a");
  assert.equal(merged.schema, 1);
});

test("budget and limit edits leave the other settings alone", () => {
  const settings = {
    schema: 1,
    values: {
      budget: { monthly_usd: 5, warn_ratio: 0.8 },
      telegram: { bot_token: "1:a", max_digests_per_day: 50, max_requests_per_hour: 10 },
    },
  };
  const budget = mergeBudgetSettings(settings, { monthly_usd: 12 });
  assert.equal(budget.values.budget.monthly_usd, 12);
  assert.equal(budget.values.budget.warn_ratio, 0.8);
  assert.equal(budget.values.telegram.bot_token, "1:a");

  // The run limits live in the telegram block, where the backend reads them.
  const limits = mergeTelegramSettings(settings, { max_requests_per_hour: 4 });
  assert.equal(limits.values.telegram.max_requests_per_hour, 4);
  assert.equal(limits.values.telegram.max_digests_per_day, 50);
  assert.equal(limits.values.telegram.bot_token, "1:a");
});

// -- channel records ----------------------------------------------------------

test("buildChannel numbers channels from one", () => {
  const channel = buildChannel(
    [],
    { title: "Канал", tg_id: "1", type: "channel" },
    "2026-09-13T12:00:00+00:00",
  );
  assert.equal(channel.id, 1);
  assert.equal(channel.username, null);
  assert.equal(channel.has_topics, false);
  assert.equal(channel.default_period_hours, 24);
  assert.deepEqual(channel.include_patterns, []);
  // Telegram ids exceed 2^53, so they must stay strings.
  assert.equal(typeof channel.tg_id, "string");
});

test("buildChannel continues the numbering and marks forums", () => {
  const channel = buildChannel(
    [{ id: 3 }, { id: 7 }],
    { title: "Форум", tg_id: "2", type: "forum", has_topics: true, default_period_hours: 6 },
    "2026-09-13T12:00:00+00:00",
  );
  assert.equal(channel.id, 8);
  assert.equal(channel.has_topics, true);
  assert.equal(channel.default_period_hours, 6);
});

// -- presentation helpers -----------------------------------------------------

test("run steps are labelled in Russian and keep their channel", () => {
  assert.deepEqual(describeStep({ name: "read:c1", status: "ok", detail: "40 сообщений" }), {
    label: "Читаю Telegram",
    detail: "40 сообщений",
    status: "ok",
  });
  // Without a detail the channel number is the fallback, so two channels in one run are
  // still distinguishable.
  assert.deepEqual(describeStep({ name: "summarize:c3", status: "running" }), {
    label: "Сжимаю через DeepSeek",
    detail: "канал 3",
    status: "running",
  });
  assert.equal(describeStep({ name: "deliver:c1", status: "failed" }).status, "failed");
  // An unknown stage must not produce an empty row.
  assert.equal(describeStep({ name: "mystery", status: "ok" }).label, "mystery");
});

test("period labels read like Russian, not like hours", () => {
  assert.equal(periodLabelFor(6), "6 ч");
  assert.equal(periodLabelFor(24), "сутки");
  assert.equal(periodLabelFor(72), "3 дня");
  assert.equal(periodLabelFor(168), "неделя");
});

test("plural picks the right Russian form", () => {
  assert.equal(channelCount(1), "1 канал");
  assert.equal(channelCount(2), "2 канала");
  assert.equal(channelCount(5), "5 каналов");
  assert.equal(channelCount(11), "11 каналов");
  assert.equal(channelCount(21), "21 канал");
  assert.equal(plural(0, ["а", "б", "в"]), "в");
});

// -- module wiring ------------------------------------------------------------

test("index.html loads the vendored libraries and the module entry point", async () => {
  const html = await readFile(new URL("frontend/index.html", ROOT), "utf8");
  assert.match(html, /<script src="\.\/vendor\/tweetnacl\.js"><\/script>/);
  assert.match(html, /<script src="\.\/vendor\/telegram-web-app\.js"><\/script>/);
  assert.match(html, /<script type="module" src="\.\/assets\/app\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\.\/assets\/design\.css" \/>/);
  // An inline icon keeps the browser from asking for /favicon.ico, which returned 404.
  assert.match(html, /<link\s+rel="icon"\s+href="data:image\/svg\+xml,/);
});

test("the theme is resolved before the first paint, in one place", async () => {
  const html = await readFile(new URL("frontend/index.html", ROOT), "utf8");
  const script = html.indexOf("documentElement.dataset.theme");
  assert.ok(script > 0, "the inline theme script is missing");
  assert.ok(script < html.indexOf("</head>"), "the theme script must run in <head>");

  const css = await readFile(new URL("frontend/assets/design.css", ROOT), "utf8");
  assert.ok(
    !/prefers-color-scheme\s*:\s*dark/.test(css),
    "design.css must not decide the theme on its own; the inline script does",
  );
});

for (const name of ASSETS) {
  test(`${name}: every named import resolves`, async () => {
    const source = await readAsset(name);
    const imports = parseImports(source);
    // Leaf modules such as bytes.js legitimately import nothing; the meaningful check is
    // that whatever *is* imported actually exists.

    for (const { specifier, names } of imports) {
      assert.match(specifier, /^\.\//, `${name} imports a non-relative path: ${specifier}`);
      const target = await import(new URL(`frontend/assets/${specifier.slice(2)}`, ROOT));
      for (const imported of names) {
        assert.ok(
          imported in target,
          `${name} imports ${imported} from ${specifier}, which does not export it`,
        );
      }
    }
  });
}

test("every element id used by the scripts exists in index.html", async () => {
  const html = await readFile(new URL("frontend/index.html", ROOT), "utf8");
  const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));

  for (const name of ASSETS) {
    const source = await readAsset(name);
    const used = new Set();
    for (const match of source.matchAll(/getElementById\("([^"]+)"\)/g)) {
      used.add(match[1]);
    }
    for (const match of source.matchAll(/querySelector\("#([A-Za-z0-9_-]+)/g)) {
      used.add(match[1]);
    }
    for (const id of used) {
      assert.ok(declared.has(id), `${name} refers to #${id}, which index.html does not define`);
    }
  }
});

test("index.html declares the shell the router draws into", async () => {
  const html = await readFile(new URL("frontend/index.html", ROOT), "utf8");
  for (const id of ["appbar", "appbar-title", "nav-back", "theme-toggle", "views", "tabbar"]) {
    assert.ok(html.includes(`id="${id}"`), `missing shell element ${id}`);
  }
  // The chrome starts hidden: the lock screen and onboarding show none of it.
  assert.match(html, /<header class="appbar" id="appbar" hidden>/);
  assert.match(html, /<nav class="tabbar" id="tabbar" hidden/);
  // The cost line lives inside the digest list rather than in a permanent bottom strip.
  assert.ok(!html.includes("footer-status"), "the global cost strip should be gone");
  const digests = await readAsset("screen-digests.js");
  assert.match(digests, /class: "spend"/);
});

test("the router knows every route a screen can navigate to", async () => {
  const app = await readAsset("app.js");
  const routes = new Set([...app.matchAll(/case "([a-z-]+)":/g)].map((match) => match[1]));
  for (const route of ["digests", "channels", "settings", "digest", "telegram-login", "onboarding"]) {
    assert.ok(routes.has(route), `app.js has no case for route "${route}"`);
  }

  const tabs = new Set(
    [...app.matchAll(/id: "(digests|channels|settings)", title:/g)].map((match) => match[1]),
  );
  for (const name of ["screen-channels.js", "screen-settings.js", "screen-digests.js", "onboarding.js"]) {
    const source = await readAsset(name);
    for (const match of source.matchAll(/navigate\("([a-z-]+)"/g)) {
      const route = match[1];
      assert.ok(
        routes.has(route) || tabs.has(route),
        `${name} navigates to "${route}", which nothing handles`,
      );
    }
  }
});

test("the vendored libraries are present and self-identifying", async () => {
  const vendor = await readFile(new URL("frontend/vendor/tweetnacl.js", ROOT), "utf8");
  assert.ok(vendor.length > 50_000, "tweetnacl.js looks truncated");
  assert.match(vendor, /nacl\.box\.keyPair/);

  const sdk = await readFile(new URL("frontend/vendor/telegram-web-app.js", ROOT), "utf8");
  assert.match(sdk, /WebApp/);
});
