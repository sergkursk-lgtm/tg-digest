// Verifies the palette in design.css against WCAG 2.1 contrast minimums.
//
// The tokens are read straight out of the stylesheet, so the test breaks the moment someone
// tweaks a colour rather than the moment a user notices. Thresholds follow the spec:
// 4.5:1 for body text, 3:1 for large text and for the boundaries of interactive controls.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(here, "..", "frontend", "assets", "design.css"), "utf8");

/** Pulls the custom properties declared in one `selector { ... }` block. */
function tokensFor(selector) {
  const start = CSS.indexOf(selector);
  assert.notEqual(start, -1, `selector not found in design.css: ${selector}`);
  const open = CSS.indexOf("{", start);
  const close = CSS.indexOf("}", open);
  const body = CSS.slice(open + 1, close);
  const out = new Map();
  for (const line of body.split("\n")) {
    const m = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(line);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

function parseColor(value) {
  const hex = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return [0, 1, 2].map((i) => parseInt(hex[i] + hex[i], 16));
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }
  throw new Error(`unsupported colour literal: ${value}`);
}

function channelToLinear(byte) {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(rgb) {
  const [r, g, b] = rgb.map(channelToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
  const a = luminance(parseColor(fg));
  const b = luminance(parseColor(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground token, background token, what it paints, minimum ratio]
const PAIRS = [
  ["--text", "--bg", "body copy on the page", 4.5],
  ["--text", "--surface", "body copy on a card", 4.5],
  ["--text", "--surface-2", "body copy on a subtle fill", 4.5],
  ["--text-muted", "--bg", "secondary copy on the page", 4.5],
  ["--text-muted", "--surface", "secondary copy on a card", 4.5],
  ["--text-muted", "--surface-2", "secondary copy on a subtle fill", 4.5],
  ["--accent", "--bg", "a link on the page", 4.5],
  ["--accent", "--surface", "a link on a card", 4.5],
  ["--accent", "--surface-2", "an active tab label", 4.5],
  ["--accent-ink", "--accent", "a primary button label", 4.5],
  ["--ok", "--ok-soft", "a success badge", 4.5],
  ["--warn", "--warn-soft", "a warning badge", 4.5],
  ["--danger", "--danger-soft", "an error badge and the danger button", 4.5],
  ["--ok", "--surface", "a success line on a card", 4.5],
  ["--warn", "--surface", "a warning line on a card", 4.5],
  ["--danger", "--surface", "an error line on a card", 4.5],
  ["--accent", "--accent-soft", "an icon on a tinted chip", 3.0],
  // A control whose boundary is the only thing identifying it must reach 3:1 (WCAG 1.4.11):
  // an input box, a switch track, an empty PIN dot.
  ["--control-edge", "--surface", "the edge of an input or switch on a card", 3.0],
  ["--control-edge", "--bg", "the edge of an input on the page", 3.0],
  ["--text", "--accent-soft", "an input sitting on a tinted panel", 4.5],
  // Toasts and badges that invert: the ink token flips with the theme on purpose.
  ["--accent-ink", "--ok", "a success toast", 4.5],
  ["--accent-ink", "--danger", "an error toast", 4.5],
  ["--bg", "--text", "an informational toast", 4.5],
];

for (const [theme, selector] of [
  ["light", ":root {"],
  ["dark", ':root[data-theme="dark"] {'],
]) {
  const tokens = tokensFor(selector);

  for (const [fg, bg, label, min] of PAIRS) {
    test(`${theme}: ${label} meets ${min}:1`, () => {
      const fgValue = tokens.get(fg);
      const bgValue = tokens.get(bg);
      assert.ok(fgValue, `${fg} is not defined for the ${theme} theme`);
      assert.ok(bgValue, `${bg} is not defined for the ${theme} theme`);
      const ratio = contrast(fgValue, bgValue);
      assert.ok(
        ratio >= min,
        `${label}: ${fg} (${fgValue}) on ${bg} (${bgValue}) is ${ratio.toFixed(2)}:1, need ${min}:1`,
      );
    });
  }
}

test("both themes define the same tokens", () => {
  const light = tokensFor(":root {");
  const dark = tokensFor(':root[data-theme="dark"] {');
  const missing = [...light.keys()].filter((k) => !dark.has(k));
  // Dark overrides colours only; sizing, motion and typography tokens stay shared.
  const colourOnly = missing.filter((k) => !/^--(dur|ease|r-|s\d|tap|font|mono)/.test(k));
  assert.deepEqual(colourOnly, [], "dark theme is missing colour tokens");
});

test("press feedback is defined and fast enough to feel immediate", () => {
  // A tap must show a result within roughly 100ms or it reads as a dropped touch.
  const tokens = tokensFor(":root {");
  const press = tokens.get("--dur-press");
  assert.equal(press, "90ms");

  const ms = Number(press.replace("ms", ""));
  assert.ok(ms > 0 && ms <= 120, `--dur-press should be 1-120ms, got ${press}`);

  // Buttons are objects: pressing one has to move it.
  for (const selector of [".btn", ".fab", ".chip", ".numpad__key"]) {
    const at = CSS.indexOf(`${selector}:active`);
    assert.notEqual(at, -1, `${selector} has no press state`);
    const rule = CSS.slice(at, CSS.indexOf("}", at));
    assert.match(rule, /transform:\s*[^;]*scale\(/, `${selector} does not scale on press`);
  }

  // Rows are surfaces, not objects: a background flash is the right feedback there, and
  // scaling a full-width row looks like a mistake.
  for (const selector of [".list__row", ".switchrow"]) {
    const at = CSS.indexOf(`${selector}:active`);
    assert.notEqual(at, -1, `${selector} has no press state`);
    const rule = CSS.slice(at, CSS.indexOf("}", at));
    assert.match(rule, /background/, `${selector} shows no press feedback`);
  }
});

test("the pressed state is painted from pointer events as well as :active", () => {
  // iOS Safari does not apply `:active` to a button unless the page listens for touches,
  // and Android's webview delays it: without a class the press would be invisible there.
  for (const selector of [".btn", ".chip", ".numpad__key", ".fab", ".list__row", ".switchrow"]) {
    assert.ok(
      CSS.includes(`${selector}.is-pressed`),
      `${selector} has no state a script can set`,
    );
  }
});

test("button-like primitives centre their own label", () => {
  // The button reset sets `text-align: inherit`, so a primitive that relies on the user
  // agent to centre its text ends up with the label pinned to the left edge. That is how
  // the PIN keypad first rendered: the digits sat against the left side of every key.
  for (const selector of [".btn", ".chip", ".numpad__key", ".tabbar__item", ".fab"]) {
    const at = CSS.indexOf(`${selector} {`);
    assert.notEqual(at, -1, `${selector} is missing`);
    const rule = CSS.slice(at, CSS.indexOf("}", at));
    assert.match(rule, /display:\s*(inline-)?flex/, `${selector} must lay its label out`);
    assert.match(rule, /align-items:\s*center/, `${selector} must centre vertically`);
    assert.match(rule, /justify-content:\s*center/, `${selector} must centre horizontally`);
  }
});

test("buttons stand on a wall and sink into it when pressed", () => {
  // `--lift` is both the height of the side wall and the distance a press travels, which
  // is what makes a press read as pushing the button down rather than shaking it.
  const tokens = tokensFor(":root {");
  assert.equal(tokens.get("--lift"), "3px");

  for (const selector of [".btn", ".chip", ".numpad__key", ".fab"]) {
    const at = CSS.indexOf(`${selector} {`);
    const rule = CSS.slice(at, CSS.indexOf("}", at));
    assert.match(rule, /box-shadow:[^;]*0 var\(--lift\) 0/, `${selector} has no side wall`);
    assert.match(rule, /inset 0 1px 0/, `${selector} has no lit top edge`);

    const pressedAt = CSS.indexOf(`${selector}:active`);
    const pressed = CSS.slice(pressedAt, CSS.indexOf("}", pressedAt));
    assert.match(
      pressed,
      /translateY\(var\(--lift\)\)/,
      `${selector} must travel down by its own thickness`,
    );
    assert.match(pressed, /box-shadow:\s*0 0 0/, `${selector} must lose its wall on press`);
  }
});

test("only compositor-friendly properties are animated", () => {
  // Animating width/height/top/left forces layout on every frame; transform and opacity do not.
  const animated = [...CSS.matchAll(/transition:\s*([^;]+);/g)]
    .flatMap((m) => m[1].split(","))
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((property) => property && property !== "none");
  const allowed = new Set([
    "transform",
    "opacity",
    "background-color",
    "border-color",
    "color",
    "box-shadow",
    "fill",
    "stroke",
  ]);
  const offenders = [...new Set(animated)].filter((p) => !allowed.has(p));
  assert.deepEqual(offenders, [], "these properties would animate layout or paint");
});

test("reduced motion removes decorative movement but keeps press feedback", () => {
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/);
  const at = CSS.indexOf("@media (prefers-reduced-motion: reduce)");
  const block = CSS.slice(at, CSS.indexOf("\n}", at));

  // The things that move on their own are switched off: slides, pulses, skeletons, shakes.
  for (const selector of [".sheet", ".scrim", ".toast", ".skeleton", ".lock--shake .lock__dots"]) {
    assert.ok(block.includes(selector), `${selector} should stop moving under reduced motion`);
  }
  assert.match(block, /animation:\s*none\s*!important/);

  // A press is not in that list on purpose: it is direct feedback that the tap landed, and
  // a blanket override here is what silently removed every press animation on a phone.
  assert.ok(
    !/\.btn[^,{]*\{/.test(block),
    "press feedback must survive reduced motion",
  );
});

test("tap targets are at least 48px", () => {
  const tokens = tokensFor(":root {");
  assert.equal(tokens.get("--tap"), "48px");
  // The tab bar is allowed a 58px row but never a shorter one.
  const tabbar = CSS.slice(CSS.indexOf(".tabbar__item {"));
  assert.match(tabbar.slice(0, tabbar.indexOf("}")), /min-height:\s*58px/);
});

test("full-width row primitives say so", () => {
  // A <button> shrink-wraps to its content even with `display: flex`, so a row that is
  // meant to fill its card must set a width. This was ragged in the channel list.
  for (const selector of [".list__row", ".switchrow"]) {
    const at = CSS.indexOf(`${selector} {`);
    assert.notEqual(at, -1, `${selector} is missing`);
    const rule = CSS.slice(at, CSS.indexOf("}", at));
    assert.match(rule, /width:\s*100%/, `${selector} must fill its container`);
  }
});
