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
import { PATHS, briefTopics, digestFileName, formatMoment } from "./state.js";
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
  progressBar,
  screen,
  skeletonRows,
  swipeToDelete,
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

/**
 * Where each stage of a run sits on the progress bar.
 *
 * The numbers are the share of the work, not the share of the wall clock: reading the
 * channel and asking the model are the two long parts, and the rest is bookkeeping around
 * them. They are only ever a floor — the bar creeps a few points past the last stage it has
 * heard about, so it moves without claiming progress that has not happened.
 */
const STAGE_PROGRESS = {
  load_settings: 6,
  select_channels: 10,
  budget_check: 14,
  read: 45,
  summarize: 82,
  store: 96,
  channels: 100,
};

/**
 * The furthest milestone a run record proves, in percent.
 *
 * Step names arrive as `read:c1` — the stage plus the channel it belongs to — so several
 * channels in one run simply take the highest value rather than stacking up.
 *
 * @param {object|null} record contents of data/runs/<id>.json
 * @returns {number} 0-100
 */
export function progressOf(record) {
  let furthest = 0;
  for (const step of record?.steps ?? []) {
    if (!step || step.status === "pending") {
      continue;
    }
    const stage = String(step.name ?? "").split(":")[0];
    const weight = STAGE_PROGRESS[stage];
    if (weight && weight > furthest) {
      furthest = weight;
    }
  }
  if (record?.status && record.status !== "running") {
    return 100;
  }
  return furthest;
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

/**
 * One bubble in the question thread.
 *
 * Just the text. The answer file still records which messages were used, but listing them
 * under every answer turned a conversation into an index, and the reader asked for the
 * answer.
 */
export function askBubble({ role, text }) {
  return el("div", {
    class: `bubble bubble--${role === "me" ? "mine" : "theirs"}`,
    text,
  });
}

/** Bring the newest entry into view, without fighting a reduced-motion preference. */
function scrollToNewest(container) {
  const newest = container.lastElementChild;
  if (!newest?.scrollIntoView) {
    return;
  }
  const calm = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  newest.scrollIntoView({ block: "nearest", behavior: calm ? "auto" : "smooth" });
}

/**
 * The digest index without one entry.
 *
 * Pure, so the one thing that can go wrong here — leaving a row in the index whose file is
 * gone, or dropping the wrong one — is testable without GitHub.
 *
 * @param {object|null} index contents of data/digests/index.json
 * @param {string} digestId
 * @returns {object} the index to write back
 */
export function withoutDigest(index, digestId) {
  const base = index ?? { schema: 1 };
  return {
    ...base,
    schema: base.schema ?? 1,
    updated_at: new Date().toISOString(),
    items: (base.items ?? []).filter((item) => item?.id !== digestId),
  };
}

/**
 * The digest index with one entry back in place.
 *
 * The index is newest first, so a restored digest goes back where it was rather than at the
 * end, which is where the reader expects to find it.
 */
export function withDigest(index, item) {
  const base = index ?? { schema: 1 };
  const items = (base.items ?? []).filter((entry) => entry?.id !== item.id);
  const at = items.findIndex(
    (entry) => String(entry.created_at ?? "") < String(item.created_at ?? ""),
  );
  if (at === -1) {
    items.push(item);
  } else {
    items.splice(at, 0, item);
  }
  return { ...base, schema: base.schema ?? 1, updated_at: new Date().toISOString(), items };
}

/** The thread about a digest, kept so that undoing a delete brings the questions back too. */
function readThread(digestId) {
  try {
    return localStorage.getItem(threadKey(digestId));
  } catch (error) {
    return null;
  }
}

/**
 * Delete one digest and return everything needed to put it back.
 *
 * The usage record stays where it is: the money was spent whether or not the digest is
 * still on screen, and quietly rewriting the month's spend would make the budget lie.
 *
 * @returns {Promise<object>} an undo record for {@link restoreDigest}
 */
export async function deleteDigest(ctx, item) {
  const stored = await ctx.client.readJson(PATHS.digest(item.id));
  const serialised = readThread(item.id);
  if (stored?.sha) {
    await ctx.client.deleteFile(PATHS.digest(item.id), `chore(digest): remove ${item.id}`, stored.sha);
  }
  const index = await ctx.client.readJson(PATHS.digestIndex);
  await ctx.client.writeJson(
    PATHS.digestIndex,
    withoutDigest(index?.data, item.id),
    `chore(index): drop ${item.id}`,
    index?.sha ?? null,
  );
  try {
    localStorage.removeItem(threadKey(item.id));
  } catch (error) {
    /* storage may be unavailable; the thread then just stays behind */
  }
  return { item, file: stored?.data ?? null, thread: serialised };
}

/** Put a deleted digest back: the file, its row in the index, and the thread. */
export async function restoreDigest(ctx, record) {
  if (!record?.item) {
    return;
  }
  if (record.file) {
    // The file is gone, so there is no sha to send.
    await ctx.client.writeJson(
      PATHS.digest(record.item.id),
      record.file,
      `chore(digest): restore ${record.item.id}`,
      null,
    );
  }
  const index = await ctx.client.readJson(PATHS.digestIndex);
  await ctx.client.writeJson(
    PATHS.digestIndex,
    withDigest(index?.data, record.item),
    `chore(index): restore ${record.item.id}`,
    index?.sha ?? null,
  );
  if (record.thread) {
    try {
      localStorage.setItem(threadKey(record.item.id), record.thread);
    } catch (error) {
      /* storage may be unavailable; the digest itself is back either way */
    }
  }
}

/**
 * Delete a digest and offer a way back for ten seconds.
 *
 * A swipe is easy to do by accident on a scrolling list, and a digest costs money and a
 * minute to rebuild. Undo costs nothing and needs no dialog in the way.
 */
export async function deleteDigestWithUndo(ctx, item) {
  try {
    const record = await deleteDigest(ctx, item);
    await ctx.refresh({ silent: true });
    toast(`${item.channel_title ?? "Дайджест"} удалён`, {
      kind: "ok",
      durationMs: 10_000,
      actionLabel: "Вернуть",
      onAction: async () => {
        try {
          await restoreDigest(ctx, record);
        } catch (error) {
          toast(`Не удалось вернуть: ${error.message}`, "error");
          return;
        }
        await ctx.refresh({ silent: true });
        toast("Дайджест вернулся", "ok");
      },
    });
    return true;
  } catch (error) {
    toast(error.message, "error");
    return false;
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
            items.map((item) => el("li", {}, [swipeRow(ctx, item)])),
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

  // No spend line, no tariff, no token count: the list is a list. The money lives in
  // settings, where it is looked at deliberately rather than read past every time.
  //
  // No heading either: the header already carries the screen name, and two identical titles
  // stacked on each other reads as a mistake.
  const node = screen([
    el("div", { class: "row row--between" }, [
      el("span", {
        class: "muted small",
        text: items.length
          ? `Собрано: ${items.length} · смахните строку влево, чтобы удалить`
          : "Пока пусто",
      }),
      button({
        label: "Обновить",
        icon: "refresh",
        variant: "quiet",
        onClick: () => ctx.refresh({ silent: true }),
      }),
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

/**
 * One digest row: tap to read it, swipe it to the left to delete it.
 *
 * There is no button behind the row and no question after it. The row follows the finger and
 * turns red once the swipe has gone far enough, so what is about to happen is visible before
 * it happens; letting go either does it or springs back, and an undo toast offers the way
 * back. The digest itself also carries a Delete button, because a keyboard has no swipe.
 */
function swipeRow(ctx, item) {
  const content = listRow({
    title: item.channel_title ?? "канал",
    sub: [periodLabel(item), item.preset_name || null].filter(Boolean).join(" · "),
    meta: `${item.messages_used ?? 0} сообщ.`,
    chevron: true,
    onClick: () => ctx.navigate("digest", { id: item.id }),
  });
  content.classList.add("swipe__content");

  const hint = el("span", { class: "swipe__hint", id: "swipe-hint" }, [
    icon("trash", 20),
    el("span", { text: "Удалить" }),
  ]);

  const wrapper = el("div", { class: "swipe" }, [hint, content]);
  swipeToDelete(wrapper, content, {
    onTrigger: () => deleteDigestWithUndo(ctx, item),
  });
  return wrapper;
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
      ? `${channelCount(list.length)} · ${hours} ч`
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
  const bar = progressBar({ label: "Обычно это занимает около минуты." });
  const retrySlot = el("div", { class: "stack" });
  const progressSheet = createSheet({
    title: "Собираю дайджест",
    body: [bar.node, retrySlot],
    dismissLabel: "Свернуть",
  });
  progressSheet.open();

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
      onProgress: (record) => bar.set(progressOf(record)),
    });

    if (!started) {
      bar.fail("Запуск не появился за две минуты. Загляните во вкладку Actions.");
      return;
    }

    if (!record) {
      bar.fail("Прогон идёт дольше 15 минут. Он не потеряется: дайджест появится в списке позже.");
      return;
    }

    if (record.status === "ok") {
      bar.finish();
      toast("Дайджест готов", "ok");
      progressSheet.close();
      await ctx.refresh({ silent: true });
      return;
    }

    bar.fail(`Не получилось: ${record.error ?? "без подробностей"}`);
    clear(retrySlot);
    retrySlot.append(
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
      retrySlot.append(el("p", { class: "small muted", text: `Запуск №${runId}` }));
    }
  } catch (error) {
    bar.fail(error.message);
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
      el("div", {}, [
        el("h1", { text: digest.channel_title ?? "дайджест" }),
        el("div", { class: "row" }, [
          // The style is how the model was asked to write; the chips below are only how
          // much of the result is on screen. They used to share the words "краткий" and
          // "полный", which is exactly how a reader ends up looking for an analytical
          // digest and finding buttons that seem to deny it exists.
          digest.preset_name
            ? el("span", { class: "badge badge--quiet", text: digest.preset_name })
            : el("span", { class: "badge badge--quiet", text: "стиль не записан" }),
          el("span", { class: "small muted", text: periodLabel(digest) }),
        ]),
      ]),
      el("div", { class: "chips" }, [
        el("button", {
          class: `chip${mode === "brief" ? " chip--on" : ""}`,
          type: "button",
          text: "Тезисы",
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
          text: "Весь текст",
          on: {
            click: () => {
              haptic("select");
              mode = "full";
              render();
            },
          },
        }),
      ]),
      el("p", {
        class: "small muted",
        text:
          mode === "brief"
            ? "По два тезиса на тему. Стиль задаётся при сборке дайджеста."
            : "Дайджест целиком, как его собрала модель.",
      }),
      // The cost and token counts are not shown here: the reader opened a digest to read
      // it, and the money is accounted for in settings.
      el("div", { class: "card" }, [article]),
      renderAskBlock(),
      el("div", { class: "row" }, [
        button({
          label: "Скачать .md",
          icon: "download",
          onClick: () => downloadText(digestFileName(digest), digest.markdown ?? ""),
        }),
        // The same delete the list offers by swiping, as a button: a keyboard or a mouse
        // has no swipe.
        button({
          label: "Удалить",
          icon: "trash",
          variant: "danger",
          onClick: async () => {
            // Back to the list first: the undo toast is offered over it, and there is
            // nothing left to read on this screen.
            ctx.back();
            await deleteDigestWithUndo(ctx, digest);
          },
        }),
      ]),
      el("p", { class: "small muted", text: `id: ${digest.id}` }),
    );
  }

  /** The question line plus the answers collected so far. */
  function renderAskBlock() {
    const list = el(
      "div",
      { class: "thread" },
      thread.map((entry) => askBubble(entry)),
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

      const entry = { role: "ai", text: answer.answer, at: new Date().toISOString() };
      thread.push(entry);
      saveThread(digestId, thread);
      list.append(askBubble(entry));
      haptic("success");
      // The thread is at the bottom of a long article, so bring the answer to the reader
      // instead of leaving them to scroll for it.
      scrollToNewest(list);
    } catch (error) {
      pending.remove();
      list.append(el("div", { class: "bubble bubble--theirs", text: error.message }));
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
