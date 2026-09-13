/**
 * First run: give the app a GitHub token and a PIN, then point the user at whatever else
 * is still missing.
 *
 * The old wizard asked for six credentials in one stream, which is exactly what the
 * redesign set out to remove. Only the token and the PIN are unavoidable up front — the
 * token is what unlocks the repository, and the PIN is what encrypts it — so those two are
 * the whole first screen. Everything else moves to Settings and is offered here as a short
 * checklist with links, not as a wall of forms.
 */

import { createVault } from "./crypto.js";
import { clear, el, field, setStatus, statusLine } from "./dom.js";
import { DEFAULT_REPO, parseRepo, saveRepo, saveVault } from "./local.js";
import { pendingSteps, setupSteps } from "./state.js";
import { actionButton, button, card, screen } from "./ui.js";

/**
 * The token + PIN step.
 *
 * @param {object} options
 * @param {HTMLElement} options.mount
 * @param {object} options.nacl the vendored tweetnacl namespace
 * @param {Function} options.clientFactory builds a client from owner/repo/token
 * @param {(client: object) => void} options.onDone called once the token is stored
 */
export function createTokenStep({ mount, nacl, clientFactory, onDone }) {
  function render() {
    const status = statusLine();
    const repository = field({
      label: "Репозиторий",
      value: DEFAULT_REPO,
      hint: "приватный репозиторий, где лежат данные",
    });
    const token = field({
      label: "GitHub-токен (fine-grained PAT)",
      type: "password",
      placeholder: "github_pat_…",
      hint: "права: Actions, Contents, Secrets (read/write) и Metadata (read)",
    });
    const pin = field({
      label: "PIN",
      type: "password",
      maxlength: "12",
      hint: "четыре цифры или больше — им будет зашифрован токен",
    });
    const pinAgain = field({ label: "PIN ещё раз", type: "password", maxlength: "12" });

    const submit = actionButton({
      label: "Проверить и продолжить",
      variant: "primary",
      block: true,
      busyLabel: "Проверяю токен…",
      action: async () => {
        try {
          if (pin.input.value.length < 4) {
            throw new Error("PIN короче 4 символов");
          }
          if (pin.input.value !== pinAgain.input.value) {
            throw new Error("PIN-ы не совпадают");
          }
          const target = parseRepo(repository.input.value);
          const value = token.input.value.trim();
          if (!value) {
            throw new Error("токен пуст");
          }

          setStatus(status, "Проверяю токен…");
          const probe = clientFactory({ owner: target.owner, repo: target.repo, token: value });
          const who = await probe.whoami();
          const access = await probe.assertRepositoryAccess();
          if (!access.canPush) {
            setStatus(
              status,
              `Токен принят (${who.login}), но у него нет права Contents: write на ${access.fullName}.`,
              "error",
            );
            return;
          }

          // Prove the token can write Secrets now: finding out later would mean redoing
          // the whole Telegram login.
          setStatus(status, "Проверяю право на запись секретов…");
          await probe.putSecret("_TG_DIGEST_PROBE", "permission-check");
          await probe.deleteSecret("_TG_DIGEST_PROBE");

          saveRepo(target.owner, target.repo);
          saveVault(await createVault(pin.input.value, value));
          setStatus(status, `Токен принят: ${who.login}.`, "ok");
          onDone(probe);
        } catch (error) {
          setStatus(status, error.message, "error");
        }
      },
    });

    clear(mount);
    mount.append(
      screen([
        el("div", { class: "lock__brand section" }, [
          el("span", { class: "lock__mark", text: "tg" }),
          el("h1", { text: "tg-digest" }),
          el("p", {
            class: "muted",
            text: "Дайджесты из Telegram-каналов: читаем сообщения, сжимаем через DeepSeek, отдаём сюда и в бота.",
          }),
        ]),
        card({
          title: "GitHub",
          children: [
            repository.field,
            token.field,
            pin.field,
            pinAgain.field,
            submit,
            status,
          ],
        }),
        el("p", {
          class: "small muted",
          text: "Токен останется только в этом браузере, зашифрованный PIN-ом. В URL, в журналы и на сервер он не попадает.",
        }),
      ]),
    );
  }

  return { render };
}

/** Where each outstanding step is fixed. */
const STEP_TARGETS = {
  "telegram-app": { label: "Открыть вход", route: "telegram-login" },
  "telegram-code": { label: "Ввести код", route: "telegram-login" },
  "telegram-session": { label: "Перенести", route: "telegram-login" },
  deepseek: { label: "Ввести ключ", route: "settings" },
  bot: { label: "Настроить", route: "settings" },
  channels: { label: "Выбрать каналы", route: "channels" },
};

/**
 * The post-token checklist: what is still missing, with one tap to each place.
 * @param {object} ctx screen context from app.js
 */
export function createOnboardingScreen(ctx) {
  const steps = setupSteps(ctx.snapshot, ctx.secretNames);
  const blocking = pendingSteps(steps);
  const optional = steps.filter((step) => step.optional && !step.hidden && !step.done);

  const row = (step) => {
    const target = STEP_TARGETS[step.id] ?? { label: "Открыть", route: "settings" };
    return el("div", { class: "list__row" }, [
      el("span", { class: `step__dot step__dot--${step.done ? "ok" : "pending"}` }),
      el("span", { class: "list__body" }, [
        el("span", { class: "list__title", text: step.title }),
        el("span", { class: "list__sub", text: step.optional ? `${step.hint} — необязательно` : step.hint }),
      ]),
      button({
        label: target.label,
        variant: step.optional ? "ghost" : "primary",
        onClick: () => ctx.navigate(target.route),
      }),
    ]);
  };

  const node = screen([
    el("div", { class: "lock__brand section" }, [
      el("span", { class: "lock__mark", text: "✓" }),
      el("h1", { text: "Токен сохранён" }),
      el("p", {
        class: "muted",
        text: blocking.length
          ? "Осталось немного: без этих шагов дайджесты не соберутся."
          : "Всё обязательное настроено — можно работать.",
      }),
    ]),
    blocking.length
      ? card({ title: "Осталось настроить", flush: true, children: blocking.map(row) })
      : null,
    optional.length
      ? card({ title: "Можно улучшить", flush: true, children: optional.map(row) })
      : null,
    button({
      label: blocking.length ? "Перейти в приложение" : "Начать",
      variant: blocking.length ? "ghost" : "primary",
      block: true,
      onClick: () => ctx.finishOnboarding(),
    }),
    el("p", {
      class: "small muted",
      text: "Все эти настройки всегда доступны на вкладке «Настройки» — вернуться сюда не нужно.",
    }),
  ]);

  return { title: "Настройка", node, chrome: { tabs: false, footer: false } };
}
