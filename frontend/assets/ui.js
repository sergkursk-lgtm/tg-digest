/**
 * Shared interface primitives: icons, sheets, dialogs, toasts, list rows.
 *
 * Screens are built from these rather than from ad-hoc markup, so a change to how a
 * button presses or how a sheet slides in happens in exactly one place.
 *
 * Two rules this file keeps:
 *   * nothing foreign reaches the DOM unescaped — every label goes through `textContent`;
 *   * every interactive surface is a real `<button>` (or a labelled control), so the
 *     keyboard and a screen reader work without extra wiring.
 */

import { el } from "./dom.js";

/**
 * Ask the Telegram client for haptic feedback.
 *
 * Outside Telegram this is a no-op, which is why callers never branch on it. Feedback is
 * used for taps that change something (a PIN digit, a switch), never for scrolling: buzzing
 * on every list row is worse than silence.
 *
 * @param {"light"|"medium"|"heavy"|"rigid"|"soft"|"success"|"warning"|"error"|"select"} [kind]
 * @param {object} [scope]
 */
export function haptic(kind = "light", scope = globalThis) {
  const feedback = scope?.Telegram?.WebApp?.HapticFeedback;
  if (!feedback) {
    return false;
  }
  try {
    if (kind === "success" || kind === "warning" || kind === "error") {
      feedback.notificationOccurred?.(kind);
    } else if (kind === "select") {
      feedback.selectionChanged?.();
    } else {
      feedback.impactOccurred?.(kind);
    }
    return true;
  } catch (error) {
    // An unsupported style must never break the interaction it was decorating.
    return false;
  }
}

// -- press feedback -----------------------------------------------------------

/**
 * Paint the pressed state from pointer events.
 *
 * CSS `:active` is not enough on its own: iOS Safari does not apply it to a `<button>`
 * unless something on the page listens for touches, and Android's webview applies it only
 * after a delay. A tap then looks like it did nothing. One delegated listener covers every
 * button, including the ones built later, and it fires on the way down — so the feedback
 * arrives with the finger, not after the browser's decision to make it a tap.
 *
 * @param {Document|HTMLElement} [root]
 * @returns {() => void} removes the listeners
 */
export function installPressFeedback(root = globalThis.document) {
  if (!root?.addEventListener) {
    return () => {};
  }
  const supportsPointer = typeof globalThis.PointerEvent === "function";
  const downEvent = supportsPointer ? "pointerdown" : "touchstart";
  const upEvents = supportsPointer ? ["pointerup", "pointercancel"] : ["touchend", "touchcancel"];

  let pressed = null;

  const clear = () => {
    pressed?.classList?.remove("is-pressed");
    pressed = null;
  };

  const down = (event) => {
    const target = event.target?.closest?.("button, .btn, .chip, .numpad__key");
    if (!target || target.disabled) {
      return;
    }
    // One at a time: a second finger must not leave the first button stuck down.
    clear();
    pressed = target;
    target.classList.add("is-pressed");
  };

  root.addEventListener(downEvent, down, { passive: true });
  for (const type of upEvents) {
    root.addEventListener(type, clear, { passive: true });
  }
  // A gesture that turns into a scroll or leaves the window must not leave a button stuck.
  root.addEventListener("scroll", clear, { passive: true, capture: true });
  globalThis.addEventListener?.("blur", clear);

  return () => {
    root.removeEventListener(downEvent, down);
    for (const type of upEvents) {
      root.removeEventListener(type, clear);
    }
    root.removeEventListener("scroll", clear, { capture: true });
    globalThis.removeEventListener?.("blur", clear);
    clear();
  };
}

// -- swipe --------------------------------------------------------------------

/** How far a swiped row travels while the gesture is in progress. */
export const SWIPE_WIDTH = 104;

/** Drag distance past which letting go acts on the row. */
export const SWIPE_TRIGGER = 56;

/**
 * Decide whether a swipe has gone far enough to act.
 *
 * Pure, so the gesture can be reasoned about without a touchscreen: the whole decision is
 * "did the finger travel far enough, to the left, to mean it".
 *
 * @param {object} options
 * @param {number} options.dx horizontal travel, negative to the left
 * @returns {boolean}
 */
export function swipeOutcome({ dx, trigger = SWIPE_TRIGGER }) {
  return dx <= -trigger;
}

/**
 * Swipe a row to the left to act on it.
 *
 * There is no button behind the row and no dialog after it: the gesture *is* the action.
 * While the finger is down the row follows it and turns red once the gesture has gone far
 * enough, so "delete" is visible before it happens; letting go either acts or springs back.
 * The caller is responsible for offering a way back, which is what the undo toast is for.
 *
 * @param {HTMLElement} wrapper the positioned container, marked with the armed state
 * @param {HTMLElement} content the part that slides
 * @param {object} options
 * @param {() => void} options.onTrigger called once when the gesture completes
 */
export function swipeToDelete(wrapper, content, { width = SWIPE_WIDTH, trigger = SWIPE_TRIGGER, onTrigger } = {}) {
  let dragging = false;
  let dx = 0;
  let startX = 0;
  let startY = 0;

  const paint = (value) => {
    content.style.transform = value ? `translateX(${value}px)` : "";
    const armed = value <= -trigger;
    wrapper.classList.toggle("swipe--armed", armed);
    content.setAttribute("aria-describedby", armed ? "swipe-hint" : null);
  };

  const onStart = (event) => {
    const touch = event.touches?.[0];
    if (!touch) {
      return;
    }
    dragging = false;
    startX = touch.clientX;
    startY = touch.clientY;
    dx = 0;
  };

  const onMove = (event) => {
    const touch = event.touches?.[0];
    if (!touch) {
      return;
    }
    dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (!dragging) {
      // A mostly vertical gesture belongs to the page scroll, not to the row.
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        return;
      }
      if (Math.abs(dx) < 10) {
        return;
      }
      dragging = true;
    }
    event.preventDefault();
    // Only to the left: there is nothing to the right, and a rubber band that goes
    // nowhere reads as a bug.
    paint(Math.max(-width, Math.min(0, dx)));
  };

  const onEnd = () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    const acted = swipeOutcome({ dx, trigger });
    paint(0);
    if (acted) {
      onTrigger?.();
    }
  };

  content.addEventListener("touchstart", onStart, { passive: true });
  // Not passive: the horizontal drag has to stop the page from scrolling sideways.
  content.addEventListener("touchmove", onMove, { passive: false });
  content.addEventListener("touchend", onEnd);
  content.addEventListener("touchcancel", onEnd);

  return {
    destroy() {
      content.removeEventListener("touchstart", onStart);
      content.removeEventListener("touchmove", onMove);
      content.removeEventListener("touchend", onEnd);
      content.removeEventListener("touchcancel", onEnd);
    },
  };
}

// -- icons --------------------------------------------------------------------

// Hand-drawn on a 24px grid, stroke-only, so they inherit `currentColor` and stay legible
// at 20px. Written here instead of pulling in an icon font: the project ships no CDN code.
const ICONS = {
  digests: [
    ["path", "M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z"],
    ["path", "M8 9h8M8 12.5h8M8 16h5"],
  ],
  channels: [
    ["path", "M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H10l-4.5 4v-4A3 3 0 0 1 4 13z"],
  ],
  settings: [
    ["path", "M4 7h9M17 7h3M4 17h3M11 17h9"],
    ["circle", "15", "7", "2.4"],
    ["circle", "9", "17", "2.4"],
  ],
  plus: [["path", "M12 5v14M5 12h14"]],
  back: [["path", "M15 5l-7 7 7 7"]],
  close: [["path", "M6 6l12 12M18 6L6 18"]],
  download: [["path", "M12 4v11M7.5 11l4.5 4.5L16.5 11M5 20h14"]],
  send: [["path", "M4.5 12L20 4.5 15 20l-3.5-6z"], ["path", "M11.5 14L20 4.5"]],
  refresh: [
    ["path", "M4.5 12a7.5 7.5 0 0 1 13-5.1L20 9"],
    ["path", "M19.5 12a7.5 7.5 0 0 1-13 5.1L4 15"],
    ["path", "M20 4v5h-5M4 20v-5h5"],
  ],
  check: [["path", "M5 12.5l4.5 4.5L19 7"]],
  spark: [["path", "M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"]],
  trash: [["path", "M5 7h14M9.5 7V5h5v2M7 7l1 13h8l1-13"]],
  chevron: [["path", "M9 6l6 6-6 6"]],
  copy: [["path", "M9.5 9.5h9v9h-9z"], ["path", "M5.5 15V5.5h9"]],
  bell: [
    ["path", "M6.5 16.5V11a5.5 5.5 0 1 1 11 0v5.5l1.5 2.5h-14z"],
    ["path", "M10 21h4"],
  ],
  key: [
    ["circle", "8", "12", "3.5"],
    ["path", "M11.5 12H21M17.5 12v3.5M21 12v2.5"],
  ],
  wallet: [
    ["path", "M4 8a2.5 2.5 0 0 1 2.5-2.5H18a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6.5A2.5 2.5 0 0 1 4 17.5z"],
    ["path", "M15.5 12.5h2.5"],
  ],
  clock: [["circle", "12", "12", "8"], ["path", "M12 7.5V12l3 2"]],
  alert: [["circle", "12", "12", "8"], ["path", "M12 8v4.5M12 16h.01"]],
  list: [["path", "M4 7h16M4 12h16M4 17h10"]],
  sun: [
    ["circle", "12", "12", "4"],
    ["path", "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"],
  ],
  moon: [["path", "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"]],
  system: [
    ["path", "M4 5.5h16v10H4z"],
    ["path", "M9 20h6M12 15.5V20"],
  ],
};

/**
 * Build an icon node.
 * @param {keyof typeof ICONS} name
 * @param {number} [size]
 * @returns {SVGSVGElement}
 */
export function icon(name, size = 20) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon");

  for (const [kind, ...rest] of ICONS[name] ?? []) {
    const node = document.createElementNS(ns, kind);
    if (kind === "circle") {
      node.setAttribute("cx", rest[0]);
      node.setAttribute("cy", rest[1]);
      node.setAttribute("r", rest[2]);
    } else {
      node.setAttribute("d", rest[0]);
    }
    node.setAttribute("vector-effect", "non-scaling-stroke");
    svg.append(node);
  }
  return svg;
}

// -- buttons ------------------------------------------------------------------

/**
 * A button with an optional leading icon.
 * @param {object} options
 * @param {string} options.label
 * @param {keyof typeof ICONS} [options.icon]
 * @param {"primary"|"ghost"|"quiet"|"danger"} [options.variant]
 * @param {boolean} [options.block]
 * @param {boolean} [options.selected]
 * @param {() => void} [options.onClick]
 * @param {"light"|"medium"|"heavy"} [options.feedback]
 */
export function button({
  label,
  icon: iconName,
  variant = "ghost",
  block = false,
  selected = false,
  onClick,
  feedback = "light",
  type = "button",
} = {}) {
  const classes = ["btn", `btn--${variant}`];
  if (block) classes.push("btn--block");
  const node = el(
    "button",
    {
      class: classes.join(" "),
      type,
      "aria-pressed": selected ? "true" : null,
      on: onClick
        ? {
            // The event is passed through: handlers commonly need `currentTarget` to
            // disable the button they were clicked on.
            click: (event) => {
              haptic(feedback);
              onClick(event);
            },
          }
        : {},
    },
    [
      iconName ? el("span", { class: "btn__icon" }, [icon(iconName, 18)]) : null,
      el("span", { text: label }),
    ],
  );
  return node;
}

/**
 * A primary button that owns its own busy state: it disables itself while `action` runs,
 * which is what stops a double tap from dispatching two workflow runs.
 *
 * @param {object} options as {@link button}, plus `action`
 * @param {() => Promise<any>} options.action
 * @param {string} [options.busyLabel]
 * @returns {HTMLButtonElement}
 */
export function actionButton({ action, busyLabel = "Работаю…", ...options }) {
  const node = button(options);
  const labelNode = node.lastElementChild;
  const original = options.label;
  node.addEventListener("click", async () => {
    if (node.disabled) {
      return;
    }
    node.disabled = true;
    labelNode.textContent = busyLabel;
    try {
      await action();
    } finally {
      node.disabled = false;
      labelNode.textContent = original;
    }
  });
  // The click handler above runs after the one `button` installed for haptics and onClick;
  // a caller that passes `onClick` gets it *before* the busy state, which is rarely what it
  // wants — use `action` instead.
  return node;
}

/**
 * The round tinted icon that opens a row.
 *
 * @param {string} name icon name
 * @param {string} [tone] "" | "quiet" | "ok" | "warn" | "danger"
 */
export function iconBadge(name, tone = "") {
  return el("span", { class: `icon-badge${tone ? ` icon-badge--${tone}` : ""}` }, [icon(name, 20)]);
}

// -- structure -----------------------------------------------------------------

/**
 * A screen: a scrollable column with consistent spacing.
 * @param {Array<Node|null>} children
 */
export function screen(children) {
  return el("section", { class: "screen" }, children);
}

/**
 * A card with an optional title and a "clear the section" header row.
 * @param {object} options
 */
export function card({ title, subtitle, actions, children, flush = false, icon: iconName } = {}) {
  const head =
    title || actions
      ? el("div", { class: "card__head" }, [
          iconName ? iconBadge(iconName) : null,
          title ? el("h2", { class: "card__title", text: title }) : null,
          ...(actions ?? []),
        ])
      : null;
  return el("div", { class: `card${flush ? " card--flush" : ""}` }, [
    head,
    subtitle ? el("p", { class: "small muted", text: subtitle }) : null,
    ...(children ?? []),
  ]);
}

/**
 * A tappable list row.
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.sub]
 * @param {string} [options.meta]
 * @param {boolean} [options.chevron]
 * @param {Node} [options.trailing]
 * @param {() => void} [options.onClick]
 */
export function listRow({ title, sub, meta, chevron = false, trailing, onClick, icon: iconName, tone = "" } = {}) {
  const body = el("span", { class: "list__body" }, [
    el("span", { class: "list__title", text: title }),
    sub ? el("span", { class: "list__sub", text: sub }) : null,
  ]);
  const children = [
    iconName ? iconBadge(iconName, tone) : null,
    body,
    meta ? el("span", { class: "list__meta", text: meta }) : null,
    trailing ?? null,
    chevron ? el("span", { class: "chev" }, [icon("chevron", 18)]) : null,
  ];

  if (!onClick) {
    return el("div", { class: "list__row" }, children);
  }
  return el(
    "button",
    {
      class: "list__row",
      type: "button",
      on: {
        click: () => {
          haptic("light");
          onClick();
        },
      },
    },
    children,
  );
}

/**
 * A labelled toggle that switches on a tap anywhere in the row.
 *
 * The `switch` element is decorative: the row itself is the button, so the accessible name
 * is the visible label and the state is exposed through `aria-pressed`.
 *
 * The flip is painted immediately and only then handed to `onToggle`, which usually ends in
 * a repository write and a re-render. Waiting for that round trip before the knob moves
 * makes a slow network look like a broken switch. If `onToggle` returns a promise that
 * rejects, the knob goes back and the row is enabled again; the caller is expected to have
 * shown the reason, because it knows what the write was for.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.sub]
 * @param {boolean} options.on
 * @param {(next: boolean) => void|Promise<any>} options.onToggle
 */
export function switchRow({ title, sub, on, onToggle, icon: iconName, tone = "" }) {
  const track = el("span", { class: `switch${on ? " switch--on" : ""}` });
  let state = Boolean(on);

  const paint = () => {
    track.classList.toggle("switch--on", state);
    node.setAttribute("aria-pressed", state ? "true" : "false");
  };

  const node = el(
    "button",
    {
      class: "switchrow",
      type: "button",
      "aria-pressed": on ? "true" : "false",
      on: {
        click: async () => {
          if (node.disabled) {
            return;
          }
          haptic("select");
          const previous = state;
          state = !state;
          paint();

          let result;
          try {
            result = onToggle(state);
          } catch (error) {
            state = previous;
            paint();
            return;
          }
          if (!result || typeof result.then !== "function") {
            return;
          }
          node.disabled = true;
          try {
            await result;
          } catch (error) {
            state = previous;
            paint();
          } finally {
            node.disabled = false;
          }
        },
      },
    },
    [
      iconName ? iconBadge(iconName, tone) : null,
      el("span", { class: "switchrow__body" }, [
        el("span", { class: "switchrow__title", text: title }),
        sub ? el("span", { class: "switchrow__sub", text: sub }) : null,
      ]),
      track,
    ],
  );
  return node;
}

/**
 * Placeholder rows shown while a list loads.
 *
 * Skeletons rather than a spinner: the shape of what is coming is more informative than a
 * rotating wheel, and it keeps the layout from jumping when data arrives.
 *
 * @param {number} [count]
 */
export function skeletonRows(count = 4) {
  return el(
    "div",
    { class: "stack", "aria-hidden": "true" },
    Array.from({ length: count }, () => el("div", { class: "skeleton skeleton--row" })),
  );
}

/**
 * An empty state with exactly one action.
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.message]
 * @param {string} [options.actionLabel]
 * @param {() => void} [options.onAction]
 */
export function emptyState({ title, message, actionLabel, onAction } = {}) {
  return el("div", { class: "empty" }, [
    el("p", { class: "empty__title", text: title }),
    message ? el("p", { text: message }) : null,
    actionLabel
      ? el("div", { class: "row", style: "justify-content:center;margin-top:var(--s4)" }, [
          button({ label: actionLabel, variant: "primary", onClick: onAction }),
        ])
      : null,
  ]);
}

/**
 * The four stages of a digest run.
 * @param {Array<{label: string, status: "pending"|"running"|"ok"|"failed", detail?: string}>} steps
 */
export function stepList(steps) {
  return el(
    "div",
    { class: "steps" },
    steps.map((step) =>
      el("div", { class: "step" }, [
        el("span", { class: `step__dot step__dot--${step.status}` }),
        el("span", { class: "list__body" }, [
          el("span", { text: step.label }),
          step.detail ? el("span", { class: "list__sub", text: step.detail }) : null,
        ]),
      ]),
    ),
  );
}

/**
 * A determinate progress bar.
 *
 * The percentage is never invented: `set` is given the furthest milestone the backend has
 * actually reported, and between milestones the bar creeps towards it by a few points so it
 * reads as alive. It never claims more than a little beyond the last thing that really
 * happened, and it only reaches 100% when the run says it is done.
 *
 * @param {object} [options]
 * @param {string} [options.label] caption under the bar
 * @returns {{node: HTMLElement, set: Function, finish: Function, fail: Function, value: Function, destroy: Function}}
 */
export function progressBar({ label = "" } = {}) {
  const fill = el("div", { class: "progress__fill" });
  const track = el(
    "div",
    {
      class: "progress__track",
      role: "progressbar",
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": "0",
    },
    [fill],
  );
  const value = el("span", { class: "progress__value", text: "0 %" });
  const caption = el("p", { class: "small muted", text: label });
  const node = el("div", { class: "progress" }, [
    track,
    el("div", { class: "row row--between" }, [value, caption]),
  ]);

  let floor = 0;
  let shown = 0;
  let timer = null;

  /** How far past the last milestone the bar may drift while it waits for the next one. */
  const CREEP = 4;

  const paint = () => {
    fill.style.transform = `scaleX(${(shown / 100).toFixed(4)})`;
    value.textContent = `${Math.round(shown)} %`;
    track.setAttribute("aria-valuenow", String(Math.round(shown)));
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const tick = () => {
    if (shown < floor) {
      // Catch up with what was reported: at least a point per tick, so a jump of forty
      // points does not spend seconds looking stuck.
      shown = Math.min(floor, shown + Math.max(1, (floor - shown) * 0.25));
    } else {
      const ceiling = Math.min(floor + CREEP, 99);
      if (shown < ceiling) {
        shown = Math.min(ceiling, shown + Math.max(0.2, (ceiling - shown) * 0.06));
      }
    }
    paint();
  };

  paint();

  return {
    node,
    /** Report the furthest milestone reached, in percent. Never moves backwards. */
    set(percent) {
      const next = Math.max(0, Math.min(100, Number(percent) || 0));
      if (next > floor) {
        floor = next;
      }
      if (!timer) {
        timer = setInterval(tick, 400);
        // In Node the returned handle can hold the process open; in a browser this is a
        // number and the call does nothing. A failing test must not hang the suite.
        timer?.unref?.();
      }
      tick();
    },
    /** The run finished: fill the bar and say so. */
    finish(text = "Готово") {
      stop();
      floor = 100;
      shown = 100;
      paint();
      caption.textContent = text;
    },
    /** The run failed: stop where it really got to, and explain. */
    fail(message) {
      stop();
      // Snap to the last confirmed milestone rather than to whatever the creep had
      // reached: the bar then shows how far the run actually got.
      shown = Math.max(floor, shown > floor + CREEP ? floor : shown);
      paint();
      fill.classList.add("progress__fill--failed");
      caption.textContent = message;
    },
    /** Stop the timer; called when the sheet is dismissed. */
    destroy: stop,
    /** What is on screen right now, which trails the target while it eases. */
    value: () => shown,
    /** The furthest milestone reported so far. */
    target: () => floor,
  };
}

// -- overlays -----------------------------------------------------------------

let toastHost = null;

/**
 * Show a short message above the bottom navigation.
 *
 * An action turns it into a way back: a destructive tap can be undone for as long as the
 * toast lives, without a dialog in front of it. `kind` alone is still accepted, because
 * that is how almost every call site uses it.
 *
 * @param {string} message
 * @param {"info"|"ok"|"error"|{kind?: string, durationMs?: number, actionLabel?: string, onAction?: Function}} [options]
 */
export function toast(message, options = "info") {
  const { kind, durationMs, actionLabel, onAction } =
    typeof options === "string"
      ? { kind: options, durationMs: 3200, actionLabel: "", onAction: null }
      : {
          kind: options.kind ?? "info",
          durationMs: options.durationMs ?? 3200,
          actionLabel: options.actionLabel ?? "",
          onAction: options.onAction ?? null,
        };

  if (!toastHost) {
    toastHost = el("div", { class: "toast-host", role: "status", "aria-live": "polite" });
    document.body.append(toastHost);
  }

  const node = el("div", { class: `toast toast--${kind}${actionLabel ? " toast--action" : ""}` }, [
    el("span", { text: message }),
    actionLabel
      ? el("button", {
          class: "toast__action",
          type: "button",
          text: actionLabel,
          on: {
            click: () => {
              // The toast goes away with the tap: an action that has been taken twice is
              // worse than one that cannot be taken twice.
              node.remove();
              onAction?.();
            },
          },
        })
      : null,
  ]);
  toastHost.append(node);
  // Two frames: the element must be in the DOM before the class that animates it lands,
  // otherwise the browser collapses both states and nothing moves.
  requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add("toast--in")));
  const fade = setTimeout(() => {
    node.classList.remove("toast--in");
    const gone = setTimeout(() => node.remove(), 240);
    // A pending timer must not hold a Node process open in the tests.
    gone?.unref?.();
  }, durationMs);
  fade?.unref?.();
  return node;
}

/**
 * A sheet that slides up from the bottom.
 *
 * Used instead of `alert()`/`confirm()`: those block the webview, are unstyled in the Mini
 * App, and cannot be animated.
 *
 * @param {object} options
 * @param {string} [options.title]
 * @param {Node|Node[]} [options.body]
 * @param {string} [options.dismissLabel]
 * @returns {{root: HTMLElement, scrim: HTMLElement, body: HTMLElement, open: Function, close: Function}}
 */
export function createSheet({ title, body, dismissLabel = "Закрыть" } = {}) {
  const bodyNode = el("div", { class: "stack" }, body ?? []);
  const sheet = el(
    "div",
    { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title ?? "Окно" },
    [
      el("div", { class: "sheet__grip", "aria-hidden": "true" }),
      title ? el("h2", { class: "sheet__title", text: title }) : null,
      bodyNode,
      el("div", { class: "section" }, [
        button({ label: dismissLabel, variant: "quiet", block: true, onClick: () => api.close() }),
      ]),
    ],
  );
  const scrim = el("div", { class: "scrim" });

  let previousFocus = null;

  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      api.close();
    }
  };

  const api = {
    root: sheet,
    scrim,
    body: bodyNode,
    isOpen: false,
    open() {
      if (api.isOpen) {
        return;
      }
      api.isOpen = true;
      previousFocus = document.activeElement;
      document.body.append(scrim, sheet);
      document.body.style.overflow = "hidden";
      document.addEventListener("keydown", onKey);
      requestAnimationFrame(() => {
        scrim.classList.add("scrim--open");
        sheet.classList.add("sheet--open");
      });
      // Focus the first control so a keyboard user lands inside the sheet, not behind it.
      requestAnimationFrame(() => {
        const target = sheet.querySelector(
          "button:not([disabled]), input, select, textarea, [tabindex]",
        );
        target?.focus?.();
      });
    },
    close() {
      if (!api.isOpen) {
        return;
      }
      api.isOpen = false;
      document.removeEventListener("keydown", onKey);
      scrim.classList.remove("scrim--open");
      sheet.classList.remove("sheet--open");
      document.body.style.overflow = "";
      setTimeout(() => {
        scrim.remove();
        sheet.remove();
      }, 240);
      if (previousFocus instanceof HTMLElement) {
        previousFocus.focus?.();
      }
    },
  };

  scrim.addEventListener("click", () => api.close());
  return api;
}

/**
 * A yes/no question, as a sheet.
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.message
 * @param {string} [options.confirmLabel]
 * @param {boolean} [options.danger]
 * @returns {Promise<boolean>}
 */
export function confirmSheet({ title, message, confirmLabel = "Да", danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const finish = (value) => {
      if (answered) {
        return;
      }
      answered = true;
      resolve(value);
      api.close();
    };
    const api = createSheet({
      title,
      body: [
        el("p", { text: message }),
        button({
          label: confirmLabel,
          variant: danger ? "danger" : "primary",
          block: true,
          onClick: () => finish(true),
        }),
      ],
      dismissLabel: "Отмена",
    });
    // Closing by scrim, Escape or "Отмена" counts as a no.
    const originalClose = api.close.bind(api);
    api.close = () => {
      if (!answered) {
        answered = true;
        resolve(false);
      }
      originalClose();
    };
    api.open();
  });
}

// -- formatting ---------------------------------------------------------------

/**
 * The Russian plural form for a count.
 * @param {number} n
 * @param {[string, string, string]} forms one / few / many
 */
export function plural(n, forms) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) {
    return forms[2];
  }
  if (last > 1 && last < 5) {
    return forms[1];
  }
  if (last === 1) {
    return forms[0];
  }
  return forms[2];
}

/** "2 канала", "5 каналов". */
export function channelCount(n) {
  return `${n} ${plural(n, ["канал", "канала", "каналов"])}`;
}
