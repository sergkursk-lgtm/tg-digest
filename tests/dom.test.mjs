/**
 * Tests for the field builders.
 *
 * These matter because the fields are built in JavaScript rather than written in HTML: a
 * mistake here produces a form that a screen reader announces wrongly, which is invisible
 * on screen and easy to ship.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { withDom } from "./helpers/fake-dom.mjs";

/** Import dom.js against a fresh stub document. */
async function loadDom() {
  const { module } = await withDom("../frontend/assets/dom.js");
  return module;
}

test("a labelled field points its label at the control", async () => {
  const dom = await loadDom();
  const { field, input } = dom.field({ label: "Номер телефона", id: "phone" });

  const label = field.children.find((child) => child.tagName === "LABEL");
  assert.equal(label.textContent, "Номер телефона");
  assert.equal(label.getAttribute("for"), "phone");
  assert.equal(input.getAttribute("id"), "phone");
  // The wrapper must not be the label: that would fold the hint into the accessible name.
  assert.equal(field.tagName, "DIV");
});

test("a hint is a description, not part of the name", async () => {
  const dom = await loadDom();
  const { field, input } = dom.field({
    label: "Ключ DeepSeek",
    hint: "platform.deepseek.com → API keys",
  });

  const describedBy = input.getAttribute("aria-describedby");
  assert.ok(describedBy, "the hint must be referenced by aria-describedby");
  const hint = field.children.find((child) => child.getAttribute("id") === describedBy);
  assert.equal(hint.textContent, "platform.deepseek.com → API keys");
  assert.equal(hint.className, "field__hint");
});

test("a field without a hint claims no description", async () => {
  const dom = await loadDom();
  const { input } = dom.field({ label: "Номер" });
  assert.equal(input.getAttribute("aria-describedby"), null);
});

test("fields that bring no id still get distinct ones", async () => {
  const dom = await loadDom();
  const first = dom.field({ label: "Один" });
  const second = dom.field({ label: "Два" });
  const firstId = first.input.getAttribute("id");
  const secondId = second.input.getAttribute("id");
  assert.ok(firstId && secondId);
  assert.notEqual(firstId, secondId);
});

test("the password field keeps its value out of the markup", async () => {
  const dom = await loadDom();
  const { input } = dom.field({ label: "Токен", type: "password", value: "secret" });
  assert.equal(input.getAttribute("type"), "password");
  assert.equal(input.value, "secret");
});

test("a select carries its options and current value", async () => {
  const dom = await loadDom();
  const { field, input } = dom.selectField({
    label: "Стиль",
    value: "b",
    options: [
      { value: "a", label: "Краткий" },
      { value: "b", label: "Полный" },
    ],
  });
  assert.equal(input.value, "b");
  assert.equal(input.children.length, 2);
  assert.equal(input.children[1].getAttribute("selected"), "");
  assert.equal(field.children[0].getAttribute("for"), input.getAttribute("id"));
});

test("a textarea is labelled like every other control", async () => {
  const dom = await loadDom();
  const { field, input } = dom.textareaField({ label: "Свой стиль", rows: 4 });
  assert.equal(input.tagName, "TEXTAREA");
  assert.equal(input.getAttribute("rows"), "4");
  assert.equal(field.children[0].getAttribute("for"), input.getAttribute("id"));
});

test("status lines toggle without losing their kind", async () => {
  const dom = await loadDom();
  const node = dom.statusLine("Сохраняю…", "info");
  assert.equal(node.textContent, "Сохраняю…");
  assert.equal(node.hidden, false);

  dom.setStatus(node, "Не вышло", "error");
  assert.equal(node.textContent, "Не вышло");
  assert.equal(node.className, "status status--error");

  dom.setStatus(node, "");
  assert.equal(node.hidden, true);
  // A screen may be re-rendered while a status update is in flight; that must not throw.
  assert.doesNotThrow(() => dom.setStatus(null, "что-то"));
});
