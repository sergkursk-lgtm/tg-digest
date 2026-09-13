/**
 * Second-layer HTML sanitiser.
 *
 * The backend already renders digest HTML from an explicit tag whitelist, so this is
 * defence in depth: if a message from Telegram ever reaches the DOM as markup, it must
 * not be able to read the encrypted GitHub token out of localStorage.
 *
 * The parsed fragment is never attached to the document while it is being cleaned, so
 * nothing runs during sanitising. Only these elements survive:
 *
 *     h1 h2 h3 p ul ol li blockquote pre code strong em s br hr a
 *
 * Everything else is either dropped entirely (script, style, iframe, object, embed,
 * form, input, svg, img…) or unwrapped, keeping its text. On `a`, only `href` and
 * `title` survive, the scheme must be http/https/tg/mailto, and `rel`/`target` are
 * forced.
 */

const ALLOWED_TAGS = new Set([
  "H1", "H2", "H3", "P", "UL", "OL", "LI", "BLOCKQUOTE",
  "PRE", "CODE", "STRONG", "EM", "S", "BR", "HR", "A",
]);

/** Elements dropped with all their content: they carry nothing worth keeping. */
const DROPPED_TAGS = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "INPUT", "BUTTON",
  "SELECT", "TEXTAREA", "SVG", "MATH", "IMG", "VIDEO", "AUDIO", "SOURCE",
  "LINK", "META", "BASE", "TEMPLATE", "NOSCRIPT",
]);

const ALLOWED_ATTRIBUTES = new Set(["HREF", "TITLE"]);

const SAFE_SCHEMES = new Set(["http:", "https:", "tg:", "mailto:"]);

/** True when a link target is safe to keep. */
export function isSafeHref(href) {
  const value = String(href ?? "").trim();
  if (!value) {
    return false;
  }
  if (/[\u0000-\u0020]/.test(value)) {
    return false; // control characters can smuggle a scheme past a naive check
  }
  // Require an explicit scheme: a relative path has nothing to resolve against inside a
  // digest, and resolving it would silently rewrite it into an https link.
  const scheme = value.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!scheme) {
    return false;
  }
  const protocol = `${scheme[1].toLowerCase()}:`;
  return SAFE_SCHEMES.has(protocol);
}

/** Detach a node from its parent. */
function detach(node) {
  if (node.parentNode) {
    node.parentNode.removeChild(node);
  }
}

/**
 * Replace an element with its own children, keeping the text.
 * @param {Element} node
 * @param {Document} document
 */
function unwrap(node, document) {
  const parent = node.parentNode;
  if (!parent) {
    return;
  }
  const children = Array.from(node.childNodes);
  for (const child of children) {
    parent.insertBefore(child, node);
  }
  parent.removeChild(node);
}

/**
 * Clean one element in place.
 * @param {Element} node
 * @param {Document} document
 */
function cleanElement(node, document) {
  const tag = String(node.tagName ?? "").toUpperCase();

  if (DROPPED_TAGS.has(tag)) {
    detach(node);
    return;
  }

  if (!ALLOWED_TAGS.has(tag)) {
    // Unknown but harmless (span, div, font…): keep the text, drop the element.
    unwrap(node, document);
    return;
  }

  for (const attribute of Array.from(node.attributes ?? [])) {
    const name = String(attribute.name ?? attribute.nodeName ?? "").toUpperCase();
    if (!ALLOWED_ATTRIBUTES.has(name)) {
      node.removeAttribute(attribute.name ?? attribute.nodeName);
      continue;
    }
    if (name === "HREF" && !isSafeHref(node.getAttribute("href"))) {
      node.removeAttribute("href");
    }
  }

  if (tag === "A") {
    if (!node.getAttribute("href")) {
      unwrap(node, document);
      return;
    }
    node.setAttribute("rel", "noopener noreferrer");
    node.setAttribute("target", "_blank");
  }
}

/**
 * Sanitise a parsed subtree in place.
 *
 * Works with any DOM implementation providing `tagName`, `childNodes`, `attributes`,
 * `getAttribute`/`setAttribute`/`removeAttribute` and the usual tree mutation methods,
 * which is what makes it testable without a browser.
 *
 * @param {Node} root
 * @param {Document} [document] defaults to the global document
 */
export function sanitizeInto(root, document = globalThis.document) {
  // Snapshot the children first: the walk mutates the tree underneath it.
  for (const child of Array.from(root.childNodes ?? [])) {
    if (child.nodeType !== 1) {
      continue; // text and comments are inert
    }
    cleanElement(child, document);
    sanitizeInto(child, document);
  }
}

/**
 * Sanitise an HTML string and return a fragment ready to insert.
 *
 * Parsing happens in a detached `<template>`, so no script runs and no resource loads
 * while the markup is being examined.
 *
 * @param {string} html
 * @param {Document} [document]
 * @returns {DocumentFragment}
 */
export function sanitizeHtml(html, document = globalThis.document) {
  const template = document.createElement("template");
  template.innerHTML = String(html ?? "");
  sanitizeInto(template.content, document);
  return template.content;
}
