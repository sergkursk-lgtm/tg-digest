/**
 * The digests screen: the list of what has been collected, the reading view, and the
 * "ask about this digest" thread underneath it.
 *
 * The list is built from `data/digests/index.json`, which is small; the full digest is
 * read only when one is opened, because a digest carries its whole rendered HTML.
 *
 * "Ask about this digest" deliberately stores no source messages. The question is queued
 * in the private branch, `ask.yml` re-reads the channel for that digest's period, answers
 * from what it finds and throws the messages away again (TASK.md §12). What stays in the
 * browser is only the question and the answer, and even that is just for convenience.
 */

import { ASK_WORKFLOW, DIGEST_WORKFLOW, pollUntil, runWorkflow } from "./backend.js";
import { clear, el } from "./dom.js";
import { sanitizeHtml } from "./sanitize.js";
import {
  PATHS,
  briefTopics,
  digestFileName,
  formatMoment,
  formatTokens,
  formatUsd,
  usageSummary,
} from "./state.js";
import { MODEL, tariffLabel } from "./tariff.js";
import { sendToBot } from "./telegram.js";
import {
  actionButton,
  button,
  card,
  channelCount,
  createSheet,
  emptyState,
  haptic,
  icon,
  listRow,
  screen,
  skeletonRows,
  stepList,
  toast,
} from "./ui.js";

/** Period choices offered when starting a run, in hours. */
const PERIOD_CHOICES = [
  { hours: 6, label: "6 часов" },
  { hours: 12, label: "12 часов" },
  { hours: 24, label: "Сутки" },
  { hours: 72, label: "3 дня" },
  { hours: 168, label: "Неделя" },
];

/** Russian labels for the stages the workflow reports. */
const STAGE_LABELS = {
  load_settings: "Читаю настройки",
  select_channels: "Выбираю каналы",
  budget_check: "Проверяю бюджет",
  read: "Читаю Telegram",
  summarize: "Сжимаю через DeepSeek",
  store: "Сохраняю дайджест",
  deliver: "Отправляю в бота",
  channels: "Завершаю",
};

/**
 * Turn a workflow step into the shape the step list renders.
 *
 * Step names arrive as `read:c1` — the stage plus the channel it belongs to — so several
 * channels in one run can be told apart.
 */
export function describeStep(step) {
  const [stage, channel] = String(step?.name ?? "").split(":");
  return {
    label: STAGE_LABELS[stage] ?? stage ?? "Шаг",
    detail: step?.detail ?? (channel ? `канал ${channel.replace(/^c/, "")}` : undefined),
    status: step?.status === "running" ? "running" : step?.status === "failed" ? "failed" : step?.status === "skipped" ? "pending" : "ok",
  };
}

/** Format the period a digest covers. */
function periodLabel(item) {
  const start = formatMoment(item?.period_start);
  const end = formatMoment(item?.period_end);
  return start === "—" ? "период неизвестен" : `${start} → ${end}`;
}

/** Keep the question thread across page reloads; questions are not secrets. */
function threadKey(digestId) {
  return `tg-digest.thread.${digestId}`;
}

function loadThread(digestId) {
  try {
    const raw = localStorage.getItem(threadKey(digestId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.text === "string") : [];
  } catch (error) {
    return [];
  }
}

function saveThread(digestId, entries) {
  try {
    // Keep the thread bounded: this is a convenience, not an archive.
    localStorage.setItem(threadKey(digestId), JSON.stringify(entries.slice(-40)));
  } catch (error) {
    /* storage may be full or unavailable; the thread then just does not persist */
  }
}

/** Download a string as a file. */
function downloadText(name, text, type = "text/markdown;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = el("a", { href: url, download: name });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick: Safari needs the URL to survive the click.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// -- list ---------------------------------------------------------------------

/**
 * The list of collected digests.
 * @param {object} ctx screen context from app.js
 */
export function createDigestsScreen(ctx) {
  const { snapshot } = ctx;
  const items = [...(snapshot.digests ?? [])].sort((left, right) =>
    String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")),
  );

  const body = items.length
    ? el(
        "div",
        { class: "card card--flush" },
        [
          el(
            "ul",
            { class: "list" },
            items.map((item) =>
              el("li", {}, [
                listRow({
                  title: item.channel_title ?? "канал",
                  sub: periodLabel(item),
                  // Two short lines beat one long one: the period needs the width more than
                  // the price does.
                  trailing: el("span", { class: "list__meta" }, [
                    el("span", { text: `${item.messages_used ?? 0} сообщ.` }),
                    el("span", { text: formatUsd(item.cost_usd) }),
                  ]),
                  chevron: true,
                  onClick: () => ctx.navigate("digest", { id: item.id }),
                }),
              ]),
            ),
          ),
        ],
      )
    : emptyState({
        title: "Дайджестов пока нет",
        message:
          snapshot.channels?.length
            ? "Соберите первый — это займёт около минуты."
            : "Сначала выберите каналы на вкладке «Каналы».",
        actionLabel: snapshot.channels?.length ? "Собрать дайджест" : null,
        onAction: () => openNewDigestSheet(ctx),
      });

  // The spend line replaces the footer calculator: on a phone a permanent strip at the
  // bottom costs more than it tells, while here it is the first thing on the screen.
  const summary = usageSummary(snapshot.usage, snapshot.settings);

  // No heading of its own: the header already carries the screen name, and two identical
  // titles stacked on each other reads as a mistake.
  const node = screen([
    el("div", { class: "row row--between" }, [
      el("span", {
        class: "muted small",
        text: items.length ? `Собрано: ${items.length}` : "Пока пусто",
      }),
      button({
        label: "Обновить",
        icon: "refresh",
        variant: "quiet",
        onClick: () => ctx.refresh({ silent: true }),
      }),
    ]),
    el("div", { class: "spend" }, [
      el("span", { class: "badge badge--quiet", text: tariffLabel(new Date()) }),
      el("span", {
        class: "spend__figure",
        text: `${formatTokens(summary.tokensIn + summary.tokensOut)} токенов`,
      }),
      el("span", {
        class: "spend__figure",
        text: `${formatUsd(summary.costUsd)} из ${formatUsd(summary.limitUsd)}`,
        dataset: { status: summary.status },
      }),
      el("span", { text: MODEL }),
    ]),
    body,
  ]);

  // The floating action is the one loud control on this screen.
  const fab =
    snapshot.channels?.length > 0
      ? el(
          "button",
          {
            class: "fab",
            type: "button",
            on: {
              click: () => {
                haptic("medium");
                openNewDigestSheet(ctx);
              },
            },
          },
          [icon("plus", 22), el("span", { text: "Собрать" })],
        )
      : null;

  return { title: "Дайджесты", node, floating: fab };
}

// -- new digest ---------------------------------------------------------------

/**
 * The "new digest" sheet: pick channels, pick a style, pick a period, run.
 *
 * @param {object} ctx
 */
export function openNewDigestSheet(ctx) {
  const { snapshot } = ctx;
  const channels = snapshot.channels ?? [];
  const presets = snapshot.presets ?? [];

  if (!channels.length) {
    toast("Сначала выберите хотя бы один канал", "error");
    ctx.navigate("channels");
    return null;
  }

  // Every channel starts selected: "collect everything I follow" is the common case.
  const selected = new Set(channels.map((channel) => channel.id));
  let presetId = presets.find((preset) => preset.is_default)?.id ?? presets[0]?.id ?? null;
  let hours = Number(channels[0]?.default_period_hours ?? 24);
  let customHours = "";

  const channelRows = channels.map((channel) => {
    const track = el("span", { class: "switch switch--on" });
    const row = el(
      "button",
      {
        class: "switchrow",
        type: "button",
        "aria-pressed": "true",
        on: {
          click: () => {
            haptic("select");
            if (selected.has(channel.id)) {
              selected.delete(channel.id);
            } else {
              selected.add(channel.id);
            }
            const on = selected.has(channel.id);
            track.className = `switch${on ? " switch--on" : ""}`;
            row.setAttribute("aria-pressed", on ? "true" : "false");
            updateSummary();
          },
        },
      },
      [
        el("span", { class: "switchrow__body" }, [
          el("span", { class: "switchrow__title", text: channel.title }),
          el("span", {
            class: "switchrow__sub",
            text: `${channel.has_topics ? "форум" : "канал"} · по умолчанию ${channel.default_period_hours} ч`,
          }),
        ]),
        track,
      ],
    );
    return row;
  });

  const periodChips = el("div", { class: "chips" });
  const styleChips = el("div", { class: "chips" });
  const summary = el("p", { class: "small muted" });

  function updateSummary() {
    const list = [...selected];
    summary.textContent = list.length
      ? `${channelCount(list.length)} · ${hours} ч · ответ придёт в бота`
      : "Ни один канал не выбран";
    runButton.disabled = list.length === 0;
  }

  // Chips are built once and only have their class toggled. Rebuilding them on every tap
  // would throw away the button under the finger and cut its press animation short.
  const styleChipNodes = [];

  function buildStyleChips() {
    if (!presets.length) {
      styleChips.append(el("p", { class: "small muted", text: "Стили не заданы — будет краткий." }));
      return;
    }
    for (const preset of presets) {
      const node = el("button", {
        class: "chip",
        type: "button",
        text: preset.name,
        on: {
          click: () => {
            haptic("select");
            presetId = preset.id;
            paintStyleChips();
          },
        },
      });
      styleChipNodes.push({ node, id: preset.id });
      styleChips.append(node);
    }
    paintStyleChips();
  }

  function paintStyleChips() {
    for (const entry of styleChipNodes) {
      entry.node.classList.toggle("chip--on", entry.id === presetId);
    }
  }

  const customInput = el("input", {
    class: "input",
    type: "number",
    inputmode: "numeric",
    min: "1",
    max: "720",
    placeholder: "своё, часов",
  });
  customInput.value = "";
  customInput.addEventListener("input", () => {
    customHours = customInput.value;
    hours = Number(customHours) > 0 ? Number(customHours) : hours;
    paintPeriodChips();
    updateSummary();
  });

  const periodChipNodes = [];

  function buildPeriodChips() {
    for (const choice of PERIOD_CHOICES) {
      const node = el("button", {
        class: "chip",
        type: "button",
        text: choice.label,
        on: {
          click: () => {
            haptic("select");
            hours = choice.hours;
            customHours = "";
            customInput.value = "";
            paintPeriodChips();
            updateSummary();
          },
        },
      });
      periodChipNodes.push({ node, hours: choice.hours });
      periodChips.append(node);
    }
    paintPeriodChips();
  }

  function paintPeriodChips() {
    for (const entry of periodChipNodes) {
      entry.node.classList.toggle("chip--on", !customHours && entry.hours === hours);
    }
  }

  const runButton = actionButton({
    label: "Собрать",
    variant: "primary",
    block: true,
    busyLabel: "Запускаю…",
    action: async () => {
      sheet.close();
      await runDigest(ctx, {
        channelIds: [...selected],
        periodHours: hours,
        presetId,
      });
    },
  });

  const sheet = createSheet({
    title: "Новый дайджест",
    body: [
      el("h3", { class: "small muted", text: "1. Каналы" }),
      el("div", { class: "card card--flush" }, channelRows),
      el("h3", { class: "small muted", text: "2. Стиль" }),
      styleChips,
      el("h3", { class: "small muted", text: "3. Период" }),
      periodChips,
      customInput,
      summary,
      runButton,
    ],
  });

  buildStyleChips();
  buildPeriodChips();
  updateSummary();
  sheet.open();
  return sheet;
}

/**
 * Start a digest run and follow it, showing the real stages the workflow reports.
 *
 * @param {object} ctx
 * @param {{channelIds: number[], periodHours: number, presetId: number|null}} options
 */
export async function runDigest(ctx, { channelIds, periodHours, presetId }) {
  const progressBody = el("div", { class: "stack" }, [
    el("p", { class: "muted", text: "Задание отправлено в GitHub Actions. Это занимает около минуты." }),
    el("div", { class: "skeleton skeleton--row" }),
  ]);
  const progressSheet = createSheet({
    title: "Собираю дайджест",
    body: [progressBody],
    dismissLabel: "Свернуть",
  });
  progressSheet.open();

  const renderSteps = (record) => {
    const steps = (record?.steps ?? []).map(describeStep);
    clear(progressBody);
    if (!steps.length) {
      progressBody.append(el("p", { class: "muted", text: "Жду первый отчёт от задачи…" }));
      return;
    }
    progressBody.append(stepList(steps));
    if (record?.error) {
      progressBody.append(el("p", { class: "status status--error", text: record.error }));
    }
  };

  try {
    const inputs = {
      channel_ids: channelIds.join(","),
      period_hours: String(periodHours ?? ""),
      dry_run: "false",
    };
    if (presetId !== null && presetId !== undefined) {
      inputs.preset_id = String(presetId);
    }

    const { runId, record, started } = await runWorkflow({
      client: ctx.client,
      workflow: DIGEST_WORKFLOW,
      inputs,
      onProgress: renderSteps,
    });

    if (!started) {
      renderSteps(null);
      progressBody.append(
        el("p", {
          class: "status status--warn",
          text: "Запуск не появился в Actions за две минуты. Проверьте вкладку Actions в репозитории.",
        }),
      );
      return;
    }

    if (!record) {
      progressBody.append(
        el("p", {
          class: "status status--warn",
          text: "Прогон идёт дольше 15 минут. Он не потеряется: результат появится в списке позже.",
        }),
      );
      return;
    }

    renderSteps(record);
    if (record.status === "ok") {
      toast("Дайджест готов", "ok");
      progressSheet.close();
      await ctx.refresh({ silent: true });
      return;
    }
    progressBody.append(
      el("p", {
        class: "status status--error",
        text: `Не получилось: ${record.error ?? "без подробностей"}`,
      }),
    );
    progressBody.append(
      button({
        label: "Повторить",
        variant: "primary",
        block: true,
        onClick: () => {
          progressSheet.close();
          runDigest(ctx, { channelIds, periodHours, presetId });
        },
      }),
    );
    if (runId) {
      progressBody.append(el("p", { class: "small muted", text: `Запуск №${runId}` }));
    }
  } catch (error) {
    progressBody.append(el("p", { class: "status status--error", text: error.message }));
  }
}

// -- detail -------------------------------------------------------------------

/**
 * One digest: the reading view with the question thread under it.
 *
 * @param {object} ctx
 * @param {string} digestId
 */
export function createDigestDetail(ctx, digestId) {
  const node = screen([skeletonRows(3)]);
  let digest = null;
  let mode = "brief";
  const thread = loadThread(digestId);

  /** Draw the article. */
  function render() {
    clear(node);
    if (!digest) {
      return;
    }

    const topics = digest.topics ?? [];
    const shown = mode === "brief" ? briefTopics(topics, 2) : topics;

    const article = el("div", { class: "digest" });
    if (mode === "full") {
      // Foreign HTML: the digest was built from Telegram messages, so it goes through the
      // whitelist sanitiser before it reaches the DOM.
      article.append(sanitizeHtml(digest.html ?? ""));
    } else if (shown.length) {
      for (const topic of shown) {
        article.append(el("h3", { text: topic.title }));
        article.append(
          el(
            "ul",
            {},
            topic.bullets.map((bullet) => el("li", { text: bullet })),
          ),
        );
      }
    } else {
      article.append(el("p", { class: "muted", text: digest.markdown ?? "Пусто." }));
    }

    node.append(
      el("div", { class: "row row--between" }, [
        el("div", {}, [
          el("h1", { text: digest.channel_title ?? "дайджест" }),
          el("p", { class: "small muted", text: periodLabel(digest) }),
        ]),
      ]),
      el("div", { class: "chips" }, [
        el("button", {
          class: `chip${mode === "brief" ? " chip--on" : ""}`,
          type: "button",
          text: "Краткий",
          on: {
            click: () => {
              haptic("select");
              mode = "brief";
              render();
            },
          },
        }),
        el("button", {
          class: `chip${mode === "full" ? " chip--on" : ""}`,
          type: "button",
          text: "Полный",
          on: {
            click: () => {
              haptic("select");
              mode = "full";
              render();
            },
          },
        }),
      ]),
      el("div", { class: "card" }, [
        el("div", { class: "row row--between small muted" }, [
          el("span", { text: `${digest.usage?.tokens_in ?? 0} токенов на вход` }),
          el("span", { text: `${formatTokens(digest.usage?.tokens_out ?? 0)} на выход` }),
          el("span", { text: formatUsd(digest.usage?.cost_usd) }),
        ]),
      ]),
      el("div", { class: "card" }, [article]),
      renderAskBlock(),
      el("div", { class: "row" }, [
        button({
          label: "Скачать .md",
          icon: "download",
          onClick: () => downloadText(digestFileName(digest), digest.markdown ?? ""),
        }),
        button({
          label: "Отправить в бота",
          icon: "send",
          onClick: (event) => resend(event.currentTarget),
        }),
      ]),
      el("p", { class: "small muted", text: `id: ${digest.id}` }),
    );
  }

  /** One answer bubble, with links to the messages it was built from. */
  function bubbleFor(entry) {
    const bubble = el("div", {
      class: `bubble bubble--${entry.role === "me" ? "mine" : "theirs"}`,
      text: entry.text,
    });
    const refs = (entry.refs ?? []).filter((ref) => ref?.link);
    if (!refs.length) {
      return bubble;
    }
    // Links, not quotes: raw message text is never stored (TASK.md §12), and a link is
    // what the reader actually wants to follow anyway.
    return el("div", { class: "bubble-group" }, [
      bubble,
      el(
        "div",
        { class: "refs" },
        refs.map((ref) =>
          el("a", {
            class: "ref",
            href: ref.link,
            target: "_blank",
            rel: "noopener noreferrer",
            text: `Сообщение от ${formatMoment(ref.date)}`,
          }),
        ),
      ),
    ]);
  }

  /** The question line plus the answers collected so far. */
  function renderAskBlock() {
    const list = el(
      "div",
      { class: "thread" },
      thread.map((entry) => bubbleFor(entry)),
    );
    if (!thread.length) {
      list.append(
        el("p", {
          class: "small muted",
          text: "Спросите что-нибудь по этому дайджесту — ответ найдётся в исходных сообщениях канала.",
        }),
      );
    }

    const input = el("input", {
      class: "input",
      type: "text",
      placeholder: "Что там было про…",
      maxlength: "500",
      "aria-label": "Вопрос по дайджесту",
    });
    const askButton = actionButton({
      label: "",
      icon: "send",
      variant: "primary",
      busyLabel: "…",
      action: async () => {
        const question = input.value.trim();
        if (!question) {
          return;
        }
        input.value = "";
        await ask(question, list);
      },
    });
    askButton.setAttribute("aria-label", "Спросить");

    const form = el("form", { class: "ask" }, [input, askButton]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      askButton.click();
    });

    return card({
      title: "Спросить у ИИ",
      children: [list, form],
    });
  }

  /**
   * Send a question and wait for the answer.
   *
   * Variant A from the plan: nothing about the source messages is kept. The workflow
   * re-reads the channel for this digest's period, answers from what it finds there, and
   * discards the messages again.
   */
  async function ask(question, list) {
    const mine = { role: "me", text: question, at: new Date().toISOString() };
    thread.push(mine);
    saveThread(digestId, thread);
    list.append(el("div", { class: "bubble bubble--mine", text: question }));

    const pending = el("div", { class: "bubble bubble--theirs" }, [
      el("div", { class: "skeleton", style: "height:16px;width:180px" }),
      el("p", {
        class: "small muted",
        text: "Ищу в сообщениях канала за период дайджеста. Это около минуты.",
      }),
    ]);
    list.append(pending);

    const askId = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z-q${Math.random()
      .toString(36)
      .slice(2, 6)}`;

    try {
      await ctx.client.writeJson(
        PATHS.askRequest,
        {
          schema: 1,
          updated_at: new Date().toISOString(),
          ask_id: askId,
          digest_id: digest.id,
          channel_id: digest.channel_id,
          question,
          period_start: digest.period_start,
          period_end: digest.period_end,
          status: "pending",
        },
        `chore(ask): ${askId}`,
      );
      await ctx.client.dispatch(ASK_WORKFLOW, { ask_id: askId });

      const answer = await pollUntil(
        async () => {
          const data = (await ctx.client.readJson(PATHS.askAnswer(askId)))?.data;
          return data && data.status !== "running" && data.status !== "pending" ? data : null;
        },
        { intervalMs: 5000, timeoutMs: 5 * 60_000 },
      );

      pending.remove();
      if (!answer) {
        const note = "Ответ не пришёл за пять минут. Загляните в Actions → ask.";
        list.append(el("div", { class: "bubble bubble--theirs", text: note }));
        return;
      }
      if (answer.status === "failed") {
        list.append(
          el("div", {
            class: "bubble bubble--theirs",
            text: `Не получилось: ${answer.error ?? "без подробностей"}`,
          }),
        );
        return;
      }

      const entry = {
        role: "ai",
        text: answer.answer,
        refs: answer.messages ?? [],
        at: new Date().toISOString(),
      };
      // `bubbleFor` is what the saved entry is rendered with on the next visit.
      thread.push(entry);
      saveThread(digestId, thread);
      list.append(bubbleFor(entry));
      haptic("success");
    } catch (error) {
      pending.remove();
      list.append(el("div", { class: "bubble bubble--theirs", text: error.message }));
    }
  }

  /** Resend the stored Telegram markup through the bot. */
  async function resend(buttonNode) {
    const telegram = ctx.snapshot.settings?.values?.telegram ?? {};
    if (!telegram.bot_token || !telegram.chat_id) {
      toast("Доставка не настроена: нет токена бота или chat_id", "error");
      return;
    }
    buttonNode.disabled = true;
    try {
      await sendToBot({
        token: telegram.bot_token,
        chatId: telegram.chat_id,
        markup: digest.telegram_html || digest.markdown || "",
      });
      toast("Отправлено в бота", "ok");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      buttonNode.disabled = false;
    }
  }

  // Load the full digest once; the index only carries the summary row.
  (async () => {
    try {
      const stored = await ctx.client.readJson(PATHS.digest(digestId));
      digest = stored?.data ?? null;
      if (!digest) {
        toast("Дайджест не найден в ветке данных", "error");
      }
    } catch (error) {
      toast(error.message, "error");
    }
    render();
  })();

  return { title: "Дайджест", node, back: true };
}
