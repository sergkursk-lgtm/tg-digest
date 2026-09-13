/**
 * Tests for the wizard's pure helpers and for the wiring of the whole page.
 *
 * The wiring tests matter more than they look: there is no bundler and no build step, so
 * a typo in an import list or in a `getElementById` would produce a blank page with the
 * error only visible in the browser console.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { buildChannel, mergeTelegramSettings } from "../frontend/assets/wizard.js";

const ROOT = new URL("../", import.meta.url);
const ASSETS = ["api.js", "app.js", "blake2b.js", "bytes.js", "crypto.js", "dom.js", "local.js", "miniapp.js", "sanitize.js", "screens.js", "seal.js", "state.js", "tariff.js", "telegram.js", "wizard.js"];

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

// -- wizard helpers -----------------------------------------------------------

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

test("buildChannel numbers channels from one", () => {
  const channel = buildChannel([], { title: "Канал", tg_id: "1", type: "channel" }, "2026-09-13T12:00:00+00:00");
  assert.equal(channel.id, 1);
  assert.equal(channel.username, null);
  assert.equal(channel.has_topics, false);
  assert.equal(channel.default_period_hours, 24);
  assert.deepEqual(channel.include_patterns, []);
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

// -- module wiring ------------------------------------------------------------

test("index.html loads the vendored library and the module entry point", async () => {
  const html = await readFile(new URL("frontend/index.html", ROOT), "utf8");
  assert.match(html, /<script src="\.\/vendor\/tweetnacl\.js"><\/script>/);
  assert.match(html, /<script src="\.\/vendor\/telegram-web-app\.js"><\/script>/);
  assert.match(html, /<script type="module" src="\.\/assets\/app\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\.\/assets\/theme\.css" \/>/);
});

for (const name of ASSETS) {
  test(`${name}: every named import resolves`, async () => {
    const source = await readAsset(name);
    const imports = parseImports(source);
    // Leaf modules such as bytes.js and blake2b.js legitimately import nothing; the
    // meaningful check is that whatever *is* imported actually exists.

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

test("index.html declares every view the app switches between", async () => {
  const html = await readFile(new URL("frontend/index.html", ROOT), "utf8");
  for (const view of ["view-welcome", "view-lock", "view-wizard", "view-app"]) {
    assert.ok(html.includes(`id="${view}"`), `missing view container ${view}`);
  }
});

test("the vendored library is present and self-identifying", async () => {
  const vendor = await readFile(new URL("frontend/vendor/tweetnacl.js", ROOT), "utf8");
  assert.ok(vendor.length > 50_000, "tweetnacl.js looks truncated");
  assert.match(vendor, /nacl\.box\.keyPair/);
});
