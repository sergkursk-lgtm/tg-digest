/**
 * Tests for the HTML sanitiser.
 *
 * The sanitiser's decisions are tested here against a small stand-in DOM, which is what
 * makes them testable in Node at all. What is *not* covered here is the browser's own
 * HTML parsing — `sanitizeHtml` only wraps `sanitizeInto` around a detached template.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isSafeHref, sanitizeHtml, sanitizeInto } from "../frontend/assets/sanitize.js";

/** Minimal element, enough for the sanitiser's operations. */
class FakeElement {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.nodeName = this.tagName;
    this.childNodes = [];
    this.parentNode = null;
    this._attributes = new Map();
  }

  get attributes() {
    return [...this._attributes].map(([name, value]) => ({ name, value }));
  }

  getAttribute(name) {
    return this._attributes.has(name) ? this._attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this._attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this._attributes.delete(name);
  }

  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child, reference) {
    const index = this.childNodes.indexOf(reference);
    child.parentNode = this;
    this.childNodes.splice(index === -1 ? this.childNodes.length : index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index !== -1) {
      this.childNodes.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent ?? "").join("");
  }
}

/** Minimal text node. */
class FakeText {
  constructor(data) {
    this.nodeType = 3;
    this.nodeName = "#text";
    this.data = data;
    this.parentNode = null;
  }

  get textContent() {
    return this.data;
  }
}

/** Minimal document, with a template whose innerHTML takes a prepared tree. */
function createDocument() {
  return {
    createElement(tag) {
      const element = new FakeElement(tag);
      if (tag.toLowerCase() === "template") {
        // A real template parses its innerHTML into `.content`, not into itself.
        element.content = new FakeElement("#fragment");
        Object.defineProperty(element, "innerHTML", {
          set(value) {
            for (const child of String(value).split("|").filter(Boolean)) {
              element.content.appendChild(build(child));
            }
          },
        });
      }
      return element;
    },
    createTextNode(text) {
      return new FakeText(text);
    },
  };
}

/**
 * Build a node from a compact spec: `tag[attr=value;attr=value]`.
 * Sibling separators are `|`, so `p|script` is two siblings. Brackets and semicolons
 * keep attribute values unambiguous even when they contain parentheses or colons.
 */
function build(spec) {
  const match = spec.match(/^([a-zA-Z0-9]+)(?:\[([^\]]*)\])?$/);
  if (!match) {
    throw new Error(`bad spec: ${spec}`);
  }
  const element = new FakeElement(match[1]);
  for (const pair of (match[2] ?? "").split(";").filter(Boolean)) {
    const separator = pair.indexOf("=");
    const name = separator === -1 ? pair : pair.slice(0, separator);
    const value = separator === -1 ? "" : pair.slice(separator + 1);
    element.setAttribute(name, value);
  }
  return element;
}

/** Find the first descendant with a tag name. */
function find(node, tag) {
  for (const child of node.childNodes ?? []) {
    if (child.tagName === tag.toUpperCase()) {
      return child;
    }
    const deeper = find(child, tag);
    if (deeper) {
      return deeper;
    }
  }
  return null;
}

/** Collect all tag names in a subtree. */
function tags(node, collected = []) {
  for (const child of node.childNodes ?? []) {
    if (child.tagName) {
      collected.push(child.tagName);
    }
    tags(child, collected);
  }
  return collected;
}

// -- link safety --------------------------------------------------------------

for (const [href, expected] of [
  ["https://example.com", true],
  ["http://example.com", true],
  ["tg://resolve?domain=x", true],
  ["mailto:a@b.c", true],
  ["javascript:alert(1)", false],
  ["JavaScript:alert(1)", false],
  ["data:text/html,<script>", false],
  ["file:///etc/passwd", false],
  ["/relative/path", false],
  ["java\nscript:alert(1)", false],
  ["", false],
  [null, false],
]) {
  test(`isSafeHref(${JSON.stringify(href)}) is ${expected}`, () => {
    assert.equal(isSafeHref(href), expected);
  });
}

// -- element decisions --------------------------------------------------------

test("allowed elements survive untouched", () => {
  const root = new FakeElement("#fragment");
  for (const spec of ["h1", "h2", "h3", "p", "ul", "ol", "li", "blockquote", "pre", "code", "strong", "em", "s", "br", "hr"]) {
    root.appendChild(build(spec));
  }
  sanitizeInto(root, createDocument());
  assert.equal(root.childNodes.length, 15);
});

test("script and style are dropped with their content", () => {
  const root = new FakeElement("#fragment");
  const script = build("script");
  script.appendChild(new FakeText("steal(localStorage.pat)"));
  root.appendChild(script);

  sanitizeInto(root, createDocument());
  assert.equal(root.childNodes.length, 0);
});

test("iframe, object, embed, form and img are dropped", () => {
  const root = new FakeElement("#fragment");
  for (const spec of ["iframe", "object", "embed", "form", "img", "svg", "input"]) {
    root.appendChild(build(spec));
  }
  sanitizeInto(root, createDocument());
  assert.deepEqual(tags(root), []);
});

test("an unknown element is unwrapped but its text is kept", () => {
  const root = new FakeElement("#fragment");
  const div = build("div[onclick=alert]");
  div.appendChild(new FakeText("полезный текст"));
  root.appendChild(div);

  sanitizeInto(root, createDocument());
  assert.deepEqual(tags(root), []);
  assert.equal(root.textContent, "полезный текст");
});

test("a dropped element inside an unknown element still goes", () => {
  const root = new FakeElement("#fragment");
  const div = build("div");
  const script = build("script");
  div.appendChild(new FakeText("текст"));
  div.appendChild(script);
  root.appendChild(div);

  sanitizeInto(root, createDocument());
  assert.deepEqual(tags(root), []);
  assert.equal(root.textContent, "текст");
});

test("a safe link keeps href and gains rel and target", () => {
  const root = new FakeElement("#fragment");
  root.appendChild(build("a[href=https://example.com/page]"));
  sanitizeInto(root, createDocument());

  const link = find(root, "a");
  assert.equal(link.getAttribute("href"), "https://example.com/page");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.equal(link.getAttribute("target"), "_blank");
});

test("a javascript: link loses its element entirely", () => {
  const root = new FakeElement("#fragment");
  const link = build("a[href=javascript:alert(1)]");
  link.appendChild(new FakeText("нажми"));
  root.appendChild(link);

  sanitizeInto(root, createDocument());
  assert.deepEqual(tags(root), []);
  assert.equal(root.textContent, "нажми");
});

test("a relative link is unwrapped because it cannot resolve in a digest", () => {
  const root = new FakeElement("#fragment");
  root.appendChild(build("a[href=/local/path]"));
  sanitizeInto(root, createDocument());
  assert.deepEqual(tags(root), []);
});

test("event handler attributes cannot survive on an allowed element", () => {
  const root = new FakeElement("#fragment");
  root.appendChild(build("p[onmouseover=alert(1);style=color:red]"));
  sanitizeInto(root, createDocument());

  const paragraph = find(root, "p");
  assert.equal(paragraph.getAttribute("onmouseover"), null);
  assert.equal(paragraph.getAttribute("style"), null);
});

test("an anchor keeps only href and title", () => {
  const root = new FakeElement("#fragment");
  root.appendChild(build("a[href=tg://resolve;onclick=alert(1);class=x]"));
  sanitizeInto(root, createDocument());

  const names = find(root, "a").attributes.map((attribute) => attribute.name).sort();
  assert.deepEqual(names, ["href", "rel", "target"]);
});

// -- the string entry point --------------------------------------------------

test("sanitizeHtml cleans whatever the template parsed", () => {
  const document = createDocument();
  const fragment = sanitizeHtml("p|script|div", document);
  assert.deepEqual(tags(fragment), ["P"]);
});

test("sanitizeHtml tolerates empty input", () => {
  const document = createDocument();
  assert.equal(sanitizeHtml("", document).childNodes.length, 0);
  assert.equal(sanitizeHtml(null, document).childNodes.length, 0);
});
