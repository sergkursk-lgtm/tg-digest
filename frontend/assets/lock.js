/**
 * The lock screen: a four-digit PIN typed on an on-screen keypad.
 *
 * There is deliberately no `<input>` anywhere in this screen. A real field summons the
 * system keyboard, which on a phone covers the whole app and hides the very thing the
 * user is looking at — the dots that show how much has been typed. Numbers are kept in
 * JavaScript and painted as dots.
 *
 * Four digits rather than six: the PIN guards a token that is already encrypted with
 * PBKDF2, and it has to be typeable with one thumb.
 *
 * The keypad is built once and only repainted in place. Rebuilding it on every press
 * would replace the button under the finger, which cancels its `:active` animation a
 * frame after it starts — the press would then feel like it did nothing.
 */

import { WrongPinError } from "./crypto.js";
import { clear, el } from "./dom.js";
import { confirmSheet, haptic, icon } from "./ui.js";

/** How many digits the PIN has. */
export const PIN_LENGTH = 4;

/** Attempts before the keypad refuses input for a while. */
const MAX_ATTEMPTS = 5;

/** How long the keypad stays locked after too many wrong PINs. */
const LOCKOUT_MS = 30_000;

/**
 * Build the lock screen.
 *
 * @param {object} options
 * @param {HTMLElement} options.mount
 * @param {(pin: string) => Promise<void>} options.onSubmit called with four digits; it
 *        should throw {@link WrongPinError} for a wrong PIN and anything else for a real
 *        failure (a revoked token, a corrupt vault)
 * @param {() => void} options.onForgot called when the user chooses to re-enter the token
 * @returns {{render: Function, destroy: Function}}
 */
export function createLockScreen({ mount, onSubmit, onForgot }) {
  let digits = "";
  let busy = false;
  let message = "";
  let failed = false;
  let attempts = 0;
  let lockedUntil = 0;
  let countdown = null;
  let submitTimer = null;

  const dotNodes = [];
  const keys = [];
  let dotsWrap = null;
  let statusNode = null;
  let rootNode = null;

  /** True while the keypad is refusing input after repeated failures. */
  function isLockedOut() {
    return Date.now() < lockedUntil;
  }

  /** Seconds left in the lockout, rounded up. */
  function secondsLeft() {
    return Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));
  }

  /** A single keypad key. */
  function key(label, { onPress, iconName = null, ariaLabel = null } = {}) {
    const node = el(
      "button",
      {
        class: "numpad__key",
        type: "button",
        "aria-label": ariaLabel ?? undefined,
        on: {
          click: () => {
            if (busy || isLockedOut()) {
              return;
            }
            haptic("light");
            onPress();
          },
        },
      },
      [iconName ? icon(iconName, 22) : el("span", { text: label })],
    );
    keys.push(node);
    return node;
  }

  /** Repaint the dots, the status line and the enabled state of the keys. */
  function paint() {
    dotNodes.forEach((node, index) => {
      const filled = index < digits.length;
      node.className = `dot${failed ? " dot--error" : filled ? " dot--filled" : ""}`;
    });
    dotsWrap?.setAttribute("aria-label", `Введено цифр: ${digits.length} из ${PIN_LENGTH}`);
    if (statusNode) {
      const locked = isLockedOut();
      statusNode.textContent =
        message || (locked ? `Слишком много попыток. Подождите ${secondsLeft()} с.` : "Введите PIN");
      statusNode.className = `status status--${failed || locked ? "error" : "info"}`;
    }
    const blocked = busy || isLockedOut();
    for (const node of keys) {
      node.disabled = blocked;
    }
    rootNode?.classList.toggle("lock--shake", failed);
  }

  /** Build the screen once. */
  function build() {
    dotNodes.length = 0;
    keys.length = 0;

    dotsWrap = el("div", { class: "lock__dots", role: "img" });
    for (let index = 0; index < PIN_LENGTH; index += 1) {
      const node = el("span", { class: "dot" });
      dotNodes.push(node);
      dotsWrap.append(node);
    }
    statusNode = el("p", {
      class: "status status--info",
      text: "Введите PIN",
      style: "text-align:center",
    });

    const numpad = el("div", { class: "numpad" }, [
      ...["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) =>
        key(digit, { onPress: () => press(digit) }),
      ),
      key("", { iconName: "back", ariaLabel: "Стереть цифру", onPress: erase }),
      key("0", { onPress: () => press("0") }),
      key("", { iconName: "check", ariaLabel: "Открыть", onPress: submit }),
    ]);

    rootNode = el("section", { class: "lock" }, [
      el("div", { class: "lock__brand" }, [
        el("span", { class: "lock__mark", text: "tg" }),
        el("h1", { text: "tg-digest" }),
        el("p", { class: "muted", text: "Дайджесты из Telegram" }),
      ]),
      el("div", {}, [dotsWrap, statusNode]),
      numpad,
      el("button", {
        class: "btn btn--quiet btn--block",
        type: "button",
        text: "Забыли PIN?",
        on: { click: () => askForgot() },
      }),
    ]);

    clear(mount);
    mount.append(rootNode);
    paint();
  }

  /** Add a digit and submit automatically on the last one. */
  function press(digit) {
    if (busy || isLockedOut() || digits.length >= PIN_LENGTH) {
      return;
    }
    failed = false;
    message = "";
    digits += digit;
    paint();
    if (digits.length === PIN_LENGTH) {
      // A short pause so the user sees the last dot fill before the screen changes.
      submitTimer = setTimeout(submit, 120);
    }
  }

  /** Remove the last digit. */
  function erase() {
    if (busy || isLockedOut() || !digits.length) {
      return;
    }
    failed = false;
    message = "";
    digits = digits.slice(0, -1);
    paint();
  }

  /** Hand the PIN over; the caller decides whether it opens the vault. */
  async function submit() {
    clearTimeout(submitTimer);
    if (busy || isLockedOut() || digits.length !== PIN_LENGTH) {
      return;
    }
    busy = true;
    const candidate = digits;
    message = "Проверяю…";
    paint();
    try {
      await onSubmit(candidate);
      busy = false;
      return;
    } catch (error) {
      busy = false;
      digits = "";
      failed = true;
      if (error instanceof WrongPinError) {
        attempts += 1;
        haptic("error");
        if (attempts >= MAX_ATTEMPTS) {
          lockedUntil = Date.now() + LOCKOUT_MS;
          attempts = 0;
          message = "";
          startCountdown();
        } else {
          message = `Неверный PIN. Осталось попыток: ${MAX_ATTEMPTS - attempts}`;
        }
      } else {
        haptic("error");
        message = error.message;
      }
      paint();
      // Restart the shake: the class has to leave the DOM and come back for the animation
      // to play a second time.
      rootNode?.classList.remove("lock--shake");
      requestAnimationFrame(() => rootNode?.classList.add("lock--shake"));
    }
  }

  /** Repaint the countdown once a second while the lockout lasts. */
  function startCountdown() {
    stopCountdown();
    countdown = setInterval(() => {
      if (!isLockedOut()) {
        stopCountdown();
        message = "";
        failed = false;
      }
      paint();
    }, 1000);
  }

  function stopCountdown() {
    if (countdown) {
      clearInterval(countdown);
      countdown = null;
    }
  }

  /** Confirm before throwing away the stored token. */
  async function askForgot() {
    const confirmed = await confirmSheet({
      title: "Забыли PIN?",
      message:
        "Токен GitHub зашифрован этим PIN-ом, восстановить его нельзя. Придётся ввести токен заново — настройки проекта в репозитории останутся на месте.",
      confirmLabel: "Ввести токен заново",
      danger: true,
    });
    if (confirmed) {
      destroy();
      onForgot();
    }
  }

  // A physical keyboard must work too: a desktop user should not have to click.
  function onKeyDown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      press(event.key);
    } else if (event.key === "Backspace") {
      event.preventDefault();
      erase();
    } else if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  }

  function destroy() {
    document.removeEventListener("keydown", onKeyDown);
    stopCountdown();
    clearTimeout(submitTimer);
  }

  return {
    render() {
      document.addEventListener("keydown", onKeyDown);
      build();
    },
    destroy,
  };
}
