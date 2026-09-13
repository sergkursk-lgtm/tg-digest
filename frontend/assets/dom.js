/**
 * Tiny DOM helpers.
 *
 * Every value that comes from outside the app — a channel title, a token, a field the
 * user typed — goes through `createElement` + `textContent`. There is no `innerHTML`
 * here on purpose: a Telegram message must never be able to become markup, and the one
 * place that does render foreign HTML (the digest preview) passes it through an
 * explicit sanitiser first.
 */

/**
 * Create an element.
 * @param {string} tag
 * @param {object} [props] attributes; `class`, `text`, `dataset`, `on` are special
 * @param {Array<Node|string>} [children]
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) {
      continue;
    }
    if (key === "class") {
      node.className = value;
    } else if (key === "text") {
      node.textContent = String(value);
    } else if (key === "dataset") {
      Object.assign(node.dataset, value);
    } else if (key === "on") {
      for (const [event, handler] of Object.entries(value)) {
        node.addEventListener(event, handler);
      }
    } else if (key === "value") {
      node.value = value;
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** Remove every child of a node. */
export function clear(node) {
  node.replaceChildren();
}

/** Show one element and hide the rest. */
export function showOnly(nodes, active) {
  for (const node of nodes) {
    node.hidden = node !== active;
  }
}

/**
 * Build a labelled form field.
 * @param {object} options
 * @param {string} options.label
 * @param {string} [options.id]
 * @param {string} [options.type]
 * @param {string} [options.value]
 * @param {string} [options.placeholder]
 * @param {string} [options.hint] helper text under the field
 * @param {boolean} [options.required]
 * @param {number} [options.maxlength]
 * @returns {{field: HTMLElement, input: HTMLInputElement}}
 */
export function field(options) {
  const input = el("input", {
    id: options.id,
    class: "input",
    type: options.type ?? "text",
    value: options.value ?? "",
    placeholder: options.placeholder ?? "",
    autocomplete: options.autocomplete ?? "off",
    spellcheck: "false",
    maxlength: options.maxlength,
    required: options.required,
  });
  const wrapper = el("label", { class: "field" }, [
    el("span", { class: "field__label", text: options.label }),
    input,
    options.hint ? el("span", { class: "field__hint", text: options.hint }) : null,
  ]);
  return { field: wrapper, input };
}

/**
 * Build a status line.
 * @param {string} [message]
 * @param {"info"|"ok"|"warn"|"error"} [kind]
 */
export function statusLine(message = "", kind = "info") {
  const node = el("p", { class: `status status--${kind}`, text: message });
  node.hidden = !message;
  return node;
}

/**
 * Set the text and visibility of a status line.
 * @param {HTMLElement} node
 * @param {string} message
 * @param {"info"|"ok"|"warn"|"error"} [kind]
 */
export function setStatus(node, message, kind = "info") {
  node.textContent = message;
  node.className = `status status--${kind}`;
  node.hidden = !message;
}
