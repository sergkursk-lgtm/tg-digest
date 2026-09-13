/**
 * A layout audit, run in the browser against a live page.
 *
 * Paste it into the devtools console (or drive it from an agent) on each screen. It answers
 * the three questions that are invisible in a screenshot but obvious to a reader:
 *
 *   * does anything stick out past the screen;
 *   * does any text overflow the box it lives in;
 *   * do any two controls overlap each other.
 *
 * It is not part of the app: nothing here is imported by a page. It exists so "проверь, что
 * ничего не залазит" is a measurement rather than an opinion.
 */
window.__layoutAudit = () => {
  const INTERACTIVE = "button, a[href], input, select, textarea, .chip, .switch, .tabbar__item, .list__row, .switchrow";

  const describe = (node) => {
    const label = (node.getAttribute?.("aria-label") || node.textContent || "").trim().slice(0, 28);
    return `${node.tagName.toLowerCase()}.${(node.className || "").toString().split(/\s+/)[0]}${
      label ? ` «${label}»` : ""
    }`;
  };

  const rect = (node) => node.getBoundingClientRect();

  const visible = (node) => {
    const r = rect(node);
    if (r.width < 1 || r.height < 1) return false;
    const style = getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  };

  const all = [...document.querySelectorAll("*")].filter(visible);
  const viewport = { width: document.documentElement.clientWidth, height: window.innerHeight };

  // 1. Anything sticking out to the right, ignoring a deliberate horizontal scroller.
  const overflow = all
    .filter((node) => {
      if (node.closest(".table-wrap, .swipe")) return false;
      return rect(node).right > viewport.width + 1;
    })
    .map((node) => `${describe(node)} right=${Math.round(rect(node).right)}`);

  // 2. Text that does not fit its own box.
  const clipped = all
    .filter((node) => {
      if (node.closest(".swipe")) return false;
      if (!node.textContent?.trim()) return false;
      const style = getComputedStyle(node);
      const scrolls = ["auto", "scroll"].includes(style.overflowX);
      if (scrolls) return false;
      // A deliberate single-line ellipsis is not a defect.
      if (style.textOverflow === "ellipsis" && style.whiteSpace === "nowrap") return false;
      return node.scrollWidth > node.clientWidth + 1;
    })
    .map((node) => `${describe(node)} scroll=${node.scrollWidth} box=${node.clientWidth}`);

  // 3. Controls overlapping each other.
  //
  // The page is stacked in layers: content, then the app's own chrome (header, bottom bar,
  // action button, toast), then a modal sheet over everything. Something on a higher layer
  // covering something lower is the point of the layer, so only a pair *within* one layer
  // counts as an overlap.
  const layer = (node) => {
    if (node.closest(".sheet, .scrim")) return 2;
    if (node.closest(".appbar, .tabbar, .fab, .toast")) return 1;
    return 0;
  };
  const controls = all.filter((node) => node.matches(INTERACTIVE));
  const overlaps = [];
  for (let i = 0; i < controls.length; i += 1) {
    for (let j = i + 1; j < controls.length; j += 1) {
      const a = controls[i];
      const b = controls[j];
      if (a.contains(b) || b.contains(a)) continue;
      if (layer(a) !== layer(b)) continue;
      const ra = rect(a);
      const rb = rect(b);
      const overlapX = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const overlapY = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (overlapX > 1 && overlapY > 1) {
        overlaps.push(
          `${describe(a)} ∩ ${describe(b)} = ${Math.round(overlapX)}×${Math.round(overlapY)}px`,
        );
      }
    }
  }

  // 4. Text whose glyph box is taller than the line it was given (a wrapped label in a
  //    fixed-height row).
  const squashed = all
    .filter((node) => {
      if (!node.textContent?.trim()) return false;
      if (node.children.length) return false;
      const style = getComputedStyle(node);
      if (style.overflow === "visible" && style.height === "auto") return false;
      const r = rect(node);
      return node.scrollHeight > r.height + 2 && style.overflowY !== "visible";
    })
    .map((node) => `${describe(node)} text=${node.scrollHeight} box=${Math.round(rect(node).height)}`);

  return {
    screen:
      document.querySelector(".appbar__title")?.textContent ??
      (document.querySelector(".lock") ? "вход" : document.querySelector(".sheet--open") ? "шторка" : "—"),
    viewport,
    scrollWidth: document.documentElement.scrollWidth,
    overflow: overflow.slice(0, 12),
    clipped: clipped.slice(0, 12),
    overlaps: overlaps.slice(0, 12),
    squashed: squashed.slice(0, 12),
    counts: {
      overflow: overflow.length,
      clipped: clipped.length,
      overlaps: overlaps.length,
      squashed: squashed.length,
    },
  };
};
