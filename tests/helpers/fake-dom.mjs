/**
 * A minimal DOM stand-in for tests.
 *
 * The project ships no DOM library and no bundler, so these tests build the smallest fake
 * document the helpers actually use. That is enough to catch the class of bug that is
 * otherwise only visible in a browser: a handler that never fires, an attribute set on the
 * wrong node, a label that does not point at its control.
 */

/** A stand-in for an element, with just the surface `dom.js` and `ui.js` touch. */
class FakeNode {
  constructor(tag, ns = null) {
    this.tagName = String(tag).toUpperCase();
    this.namespace = ns;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = { setProperty() {} };
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.parent = null;
  }

  get classList() {
    return {
      add: (...names) => {
        const set = new Set(this._classes());
        for (const name of names) set.add(name);
        this.className = [...set].join(" ");
      },
      remove: (...names) => {
        const set = new Set(this._classes());
        for (const name of names) set.delete(name);
        this.className = [...set].join(" ");
      },
      contains: (name) => this._classes().includes(name),
      toggle: (name, force) => {
        const has = this._classes().includes(name);
        const want = force === undefined ? !has : Boolean(force);
        if (want && !has) this.classList.add(name);
        if (!want && has) this.classList.remove(name);
        return want;
      },
    };
  }

  _classes() {
    return this.className.split(/\s+/).filter(Boolean);
  }

  get firstElementChild() {
    return this.children.find((child) => child instanceof FakeNode) ?? null;
  }

  get lastElementChild() {
    return this.children.filter((child) => child instanceof FakeNode).pop() ?? null;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      this.children.push(node);
      if (node instanceof FakeNode) node.parent = this;
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(type, handler) {
    const list = (this.listeners.get(type) ?? []).filter((entry) => entry !== handler);
    this.listeners.set(type, list);
  }

  /** Fire an event, the way a browser would. */
  fire(type, event = {}) {
    const payload = { type, currentTarget: this, target: this, preventDefault() {}, ...event };
    for (const handler of this.listeners.get(type) ?? []) handler(payload);
    return payload;
  }

  /** Take the node out of its parent, the way `Element.remove` does. */
  remove() {
    const siblings = this.parent?.children;
    if (Array.isArray(siblings)) {
      const at = siblings.indexOf(this);
      if (at !== -1) {
        siblings.splice(at, 1);
      }
    }
    this.parent = null;
  }

  /** Walk up to the nearest ancestor matching a simple tag or class selector. */
  closest(selector) {
    const wanted = String(selector)
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    let node = this;
    while (node) {
      const hit = wanted.some((entry) =>
        entry.startsWith(".")
          ? node.classList?.contains(entry.slice(1))
          : node.tagName === entry.toUpperCase(),
      );
      if (hit) {
        return node;
      }
      node = node.parent ?? null;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const wanted = selector.replace(/^\./, "");
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (!(child instanceof FakeNode)) continue;
        if (selector.startsWith(".") && child.classList.contains(wanted)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  /** Every descendant matching a predicate, for assertions. */
  findAll(predicate) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (!(child instanceof FakeNode)) continue;
        if (predicate(child)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

/**
 * Install the stub document and import a module that needs it.
 *
 * The query string defeats Node's module cache, so a module that captured `document` at
 * import time gets the stub of *this* test rather than the first one's.
 *
 * @param {string} specifier path of the module under test, relative to tests/
 */
export async function withDom(specifier = "../frontend/assets/ui.js") {
  const document = {
    createElement: (tag) => {
      const node = new FakeNode(tag);
      if (String(tag).toLowerCase() === "template") {
        // `sanitizeHtml` parses into a detached template and then walks its content. A real
        // browser does the parsing; this stand-in cannot, so the template it hands back holds
        // an empty fragment and the sanitiser returns nothing. Its own decisions are covered
        // against a prepared tree in sanitize.test.mjs, and the browser path is checked on a
        // live screen with tools/layout-audit.js.
        node.content = new FakeNode("#fragment");
      }
      return node;
    },
    createElementNS: (ns, tag) => new FakeNode(tag, ns),
    createTextNode: (text) => ({ nodeType: 3, textContent: text, children: [] }),
    body: new FakeNode("body"),
    documentElement: new FakeNode("html"),
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.document = document;
  globalThis.requestAnimationFrame = (fn) => {
    fn();
    return 0;
  };
  // Resolve against tests/, which is how the specifier is written at the call site.
  const target = new URL(specifier, new URL("../", import.meta.url));
  const module = await import(`${target.href}?stub=${Math.random()}`);
  return { module, document };
}

