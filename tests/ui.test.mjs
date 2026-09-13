/**
 * Tests for the interface primitives, on a minimal DOM stub.
 *
 * The project ships no DOM library and no bundler, so these tests build the smallest fake
 * document the helpers actually use. That is enough to catch the class of bug that is
 * otherwise only visible in a browser: a handler that never fires, an attribute that is
 * set on the wrong node, a toggle that stops toggling.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { withDom as withDomModule } from "./helpers/fake-dom.mjs";

/** Import ui.js against a fresh stub document. */
async function withDom() {
  const { module } = await withDomModule("../frontend/assets/ui.js");
  return { ui: module };
}

test("button forwards the click event to its handler", async () => {
  const { ui } = await withDom();
  // This is the bug that made "Загрузить мои чаты" do nothing in the browser: the handler
  // reached for `event.currentTarget` and the event was never passed.
  let seen = null;
  const node = ui.button({ label: "Нажми", onClick: (event) => (seen = event) });
  const event = node.fire("click");
  assert.equal(seen, event);
  assert.equal(seen.currentTarget, node);
});

test("button carries its label, variant and block flag", async () => {
  const { ui } = await withDom();
  const node = ui.button({ label: "Собрать", variant: "primary", block: true, icon: "plus" });
  assert.equal(node.className, "btn btn--primary btn--block");
  assert.equal(node.getAttribute("type"), "button");
  // The label lives in a span next to the icon, which is what `actionButton` rewrites.
  assert.equal(node.lastElementChild.textContent, "Собрать");
  assert.equal(node.firstElementChild.className, "btn__icon");
});

test("actionButton disables itself while the action runs", async () => {
  const { ui } = await withDom();
  let resolve;
  const running = new Promise((done) => (resolve = done));
  const node = ui.actionButton({
    label: "Собрать",
    busyLabel: "Работаю…",
    action: () => running,
  });
  node.fire("click");
  assert.equal(node.disabled, true);
  assert.equal(node.lastElementChild.textContent, "Работаю…");

  resolve();
  await running;
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(node.disabled, false);
  assert.equal(node.lastElementChild.textContent, "Собрать");
});

test("switchRow reports its state and flips it on a tap", async () => {
  const { ui } = await withDom();
  const seen = [];
  const node = ui.switchRow({ title: "Клуб", sub: "форум", on: false, onToggle: (next) => seen.push(next) });

  assert.equal(node.getAttribute("aria-pressed"), "false");
  assert.equal(node.querySelector(".switch").classList.contains("switch--on"), false);

  node.fire("click");
  assert.deepEqual(seen, [true]);
  assert.equal(node.querySelector(".switch").classList.contains("switch--on"), true);
  assert.equal(node.getAttribute("aria-pressed"), "true");
});

test("a failed toggle puts the switch back where it was", async () => {
  const { ui } = await withDom();
  const node = ui.switchRow({
    title: "Клуб",
    on: false,
    onToggle: async () => {
      throw new Error("нет прав на запись");
    },
  });

  node.fire("click");
  // The failure arrives a tick later, the way a rejected request would.
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(node.querySelector(".switch").classList.contains("switch--on"), false);
  assert.equal(node.getAttribute("aria-pressed"), "false");
  assert.equal(node.disabled, false, "the row must stay tappable after a failure");
});

test("list rows are buttons only when they do something", async () => {
  const { ui } = await withDom();
  const inert = ui.listRow({ title: "Стиль", sub: "краткий" });
  assert.equal(inert.tagName, "DIV");

  let taps = 0;
  const tappable = ui.listRow({ title: "Клуб", onClick: () => (taps += 1) });
  assert.equal(tappable.tagName, "BUTTON");
  tappable.fire("click");
  assert.equal(taps, 1);
});

test("skeletons stand in for the number of rows asked for", async () => {
  const { ui } = await withDom();
  const node = ui.skeletonRows(3);
  assert.equal(node.querySelectorAll(".skeleton--row").length, 3);
});

test("an empty state offers at most one action", async () => {
  const { ui } = await withDom();
  let clicked = 0;
  const node = ui.emptyState({
    title: "Пока пусто",
    message: "Соберите первый",
    actionLabel: "Собрать",
    onAction: () => (clicked += 1),
  });
  const buttons = node.findAll((child) => child.tagName === "BUTTON");
  assert.equal(buttons.length, 1);
  buttons[0].fire("click");
  assert.equal(clicked, 1);

  const bare = ui.emptyState({ title: "Пока пусто" });
  assert.equal(bare.findAll((child) => child.tagName === "BUTTON").length, 0);
});

test("stepList marks every stage", async () => {
  const { ui } = await withDom();
  const node = ui.stepList([
    { label: "Читаю Telegram", status: "ok" },
    { label: "Сжимаю", status: "running" },
    { label: "Сохраняю", status: "pending" },
  ]);
  const dots = node.querySelectorAll(".step__dot");
  assert.equal(dots.length, 3);
  assert.equal(dots[0].classList.contains("step__dot--ok"), true);
  assert.equal(dots[1].classList.contains("step__dot--running"), true);
  assert.equal(dots[2].classList.contains("step__dot--pending"), true);
});
