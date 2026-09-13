/**
 * The channels screen: every chat of the Telegram account, with a switch for the ones
 * that should become digest sources.
 *
 * The list of chats comes from `data/login/dialogs.json`, which `telegram-list.yml`
 * writes. Ticking a chat adds it to `data/channels.json`; unticking removes it. The style
 * and the period live on the channel, and both are edited in the sheet at the bottom.
 *
 * Private conversations and Telegram's own service chat are filtered out by
 * `selectableDialogs`: a digest is for channels and groups, and a directory of someone's
 * private chats has no business being listed here.
 */

import { LIST_WORKFLOW, buildChannel, pollUntil, runWorkflow } from "./backend.js";
import { el } from "./dom.js";
import { PATHS, dialogToChannel, formatMoment, selectableDialogs } from "./state.js";
import {
  button,
  card,
  channelCount,
  createSheet,
  emptyState,
  haptic,
  listRow,
  screen,
  switchRow,
  toast,
} from "./ui.js";

/** Period choices offered per channel, in hours. */
const PERIOD_CHOICES = [6, 12, 24, 72, 168];

/** Human labels for the groups in the chat list. */
const GROUPS = [
  { type: "forum", title: "Форумы" },
  { type: "channel", title: "Каналы" },
  { type: "group", title: "Группы" },
];

/** "6 ч" / "3 дня" / "1 неделя". */
export function periodLabelFor(hours) {
  const value = Number(hours ?? 0);
  if (value === 24) return "сутки";
  if (value === 168) return "неделя";
  if (value === 72) return "3 дня";
  return `${value} ч`;
}

/** Read data/channels.json with its sha, so writes keep the other channels intact. */
async function readChannels(client) {
  const stored = await client.readJson(PATHS.channels);
  return { items: stored?.data?.items ?? [], sha: stored?.sha ?? null };
}

/** Write the channel list back, preserving a fresh sha on every attempt. */
async function writeChannels(client, items, message) {
  const stored = await client.readJson(PATHS.channels);
  const payload = {
    schema: 1,
    updated_at: new Date().toISOString(),
    items,
  };
  await client.writeJson(PATHS.channels, payload, message, stored?.sha ?? null);
}

/**
 * Add or remove a channel, then reload the snapshot.
 * @param {object} ctx
 * @param {object} channel channel record to add or remove (matched by tg_id)
 * @param {boolean} on
 */
async function toggleChannel(ctx, channel, on) {
  const { items } = await readChannels(ctx.client);
  if (on) {
    if (items.some((item) => String(item.tg_id) === String(channel.tg_id))) {
      return;
    }
    items.push(buildChannel(items, channel, new Date().toISOString()));
    await writeChannels(
      ctx.client,
      items,
      `feat(channels): add ${channel.title}`.slice(0, 70),
    );
    toast(`${channel.title} добавлен`, "ok");
  } else {
    const kept = items.filter((item) => String(item.tg_id) !== String(channel.tg_id));
    if (kept.length === items.length) {
      return;
    }
    await writeChannels(ctx.client, kept, `chore(channels): remove ${channel.title}`.slice(0, 70));
    toast(`${channel.title} убран`, "info");
  }
  await ctx.refresh({ silent: true });
}

/** Save a style/period change on a channel that is already selected. */
async function updateChannelSettings(ctx, channelId, patch) {
  const { items } = await readChannels(ctx.client);
  const next = items.map((item) =>
    item.id === channelId ? { ...item, ...patch } : item,
  );
  await writeChannels(ctx.client, next, `chore(channels): tune #${channelId}`);
  await ctx.refresh({ silent: true });
}

/**
 * The sheet for one selected channel: style and period.
 * @param {object} ctx
 * @param {object} channel
 */
function openChannelSettingsSheet(ctx, channel) {
  const presets = ctx.snapshot.presets ?? [];
  let presetId = channel.summary_style_id ?? presets.find((preset) => preset.is_default)?.id ?? null;
  let hours = Number(channel.default_period_hours ?? 24);

  const styleChips = el("div", { class: "chips" });
  const periodChips = el("div", { class: "chips" });
  const styleNodes = [];
  const periodNodes = [];

  // Built once, then toggled: a rebuilt chip would lose the press it is animating.
  function buildStyles() {
    if (!presets.length) {
      styleChips.append(el("p", { class: "small muted", text: "Стили не заданы." }));
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
            paintStyles();
          },
        },
      });
      styleNodes.push({ node, id: preset.id });
      styleChips.append(node);
    }
    paintStyles();
  }

  function paintStyles() {
    for (const entry of styleNodes) {
      entry.node.classList.toggle("chip--on", entry.id === presetId);
    }
  }

  function buildPeriods() {
    for (const choice of PERIOD_CHOICES) {
      const node = el("button", {
        class: "chip",
        type: "button",
        text: periodLabelFor(choice),
        on: {
          click: () => {
            haptic("select");
            hours = choice;
            paintPeriods();
          },
        },
      });
      periodNodes.push({ node, hours: choice });
      periodChips.append(node);
    }
    paintPeriods();
  }

  function paintPeriods() {
    for (const entry of periodNodes) {
      entry.node.classList.toggle("chip--on", entry.hours === hours);
    }
  }

  const sheet = createSheet({
    title: channel.title,
    body: [
      el("p", { class: "small muted", text: "Стиль применяется к этому каналу по умолчанию." }),
      styleChips,
      el("h3", { class: "small muted", text: "Период по умолчанию" }),
      periodChips,
      button({
        label: "Сохранить",
        variant: "primary",
        block: true,
        onClick: async () => {
          sheet.close();
          await updateChannelSettings(ctx, channel.id, {
            summary_style_id: presetId,
            default_period_hours: hours,
          });
        },
      }),
    ],
  });

  buildStyles();
  buildPeriods();
  sheet.open();
}

/** Refresh the chat directory by running telegram-list.yml. */
async function refreshDialogs(ctx, statusNode, buttonNode) {
  buttonNode.disabled = true;
  statusNode.hidden = false;
  statusNode.className = "status status--info";
  statusNode.textContent = "Запускаю чтение списка чатов…";
  try {
    const before = ctx.snapshot.dialogsUpdatedAt ?? null;
    const { started } = await runWorkflow({
      client: ctx.client,
      workflow: LIST_WORKFLOW,
      inputs: {},
      // This workflow writes the chat list, not a run record: follow the list instead of
      // waiting out a timeout for a file that never appears.
      waitForRecord: false,
      onRunStarted: () => {
        statusNode.textContent = "Читаю чаты из Telegram…";
      },
    });
    if (!started) {
      statusNode.className = "status status--warn";
      statusNode.textContent = "Запуск не появился в Actions за две минуты.";
      return;
    }
    statusNode.textContent = "Читаю список чатов…";
    const stored = await pollUntil(
      async () => {
        const read = await ctx.client.readJson(PATHS.dialogs);
        const stamp = read?.data?.updated_at ?? null;
        return stamp && stamp !== before ? read.data : null;
      },
      { intervalMs: 4000, timeoutMs: 5 * 60_000 },
    );
    if (!stored) {
      statusNode.className = "status status--warn";
      statusNode.textContent = "Список не обновился за пять минут — посмотрите Actions.";
      return;
    }
    statusNode.className = "status status--ok";
    statusNode.textContent = `Готово: ${(stored.items ?? []).length} чатов.`;
    await ctx.refresh({ silent: true });
  } catch (error) {
    statusNode.className = "status status--error";
    statusNode.textContent = error.message;
  } finally {
    buttonNode.disabled = false;
  }
}

/**
 * The channels screen.
 * @param {object} ctx screen context from app.js
 */
export function createChannelsScreen(ctx) {
  const { snapshot } = ctx;
  const selected = snapshot.channels ?? [];
  const dialogs = selectableDialogs(snapshot.dialogs ?? []);
  const selectedIds = new Set(selected.map((channel) => String(channel.tg_id)));

  const status = el("p", { class: "status", hidden: true });

  /** Rows for the chats the account is in, grouped by kind. */
  function chatGroups() {
    const nodes = [];
    for (const group of GROUPS) {
      const items = dialogs.filter((dialog) => dialog.type === group.type);
      if (!items.length) {
        continue;
      }
      nodes.push(el("h3", { class: "small muted section", text: group.title }));
      nodes.push(
        el("div", { class: "card card--flush" }, [
          el(
            "div",
            {},
            items.map((dialog) => {
              const channel = dialogToChannel(dialog);
              const on = selectedIds.has(String(channel.tg_id));
              return switchRow({
                title: channel.title,
                sub: [
                  channel.has_topics ? "форум" : group.title.toLowerCase(),
                  channel.username ? `@${channel.username}` : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
                on,
                // The switch flips immediately; the write follows. A failure reverts the
                // knob, so the list never claims something that was not saved.
                onToggle: async (next) => {
                  try {
                    await toggleChannel(ctx, channel, next);
                  } catch (error) {
                    toast(error.message, "error");
                    throw error;
                  }
                },
              });
            }),
          ),
        ]),
      );
    }
    return nodes;
  }

  const refreshButton = button({
    label: dialogs.length ? "Обновить список чатов" : "Загрузить мои чаты",
    icon: "refresh",
    onClick: () => refreshDialogs(ctx, status, refreshButton),
  });

  const listNode = dialogs.length
    ? el("div", {}, chatGroups())
    : el("div", { class: "card" }, [
        emptyState({
          title: "Список чатов ещё не загружен",
          message:
            "Приложение прочитает список ваших чатов из Telegram — только названия и типы, без сообщений.",
        }),
      ]);

  const selectedBlock = selected.length
    ? el("div", { class: "card card--flush" }, [
        el(
          "ul",
          { class: "list" },
          selected.map((channel) =>
            el("li", {}, [
              listRow({
                title: channel.title,
                sub: `период ${periodLabelFor(channel.default_period_hours)} · ${
                  (snapshot.presets ?? []).find((preset) => preset.id === channel.summary_style_id)
                    ?.name ?? "стиль по умолчанию"
                }`,
                meta: channel.has_topics ? "форум" : null,
                chevron: true,
                onClick: () => openChannelSettingsSheet(ctx, channel),
              }),
            ]),
          ),
        ),
      ])
    : el("p", { class: "muted small", text: "Пока ничего не выбрано." });

  const node = screen([
    el("p", {
      class: "small muted",
      text: "Отметьте чаты, из которых нужны дайджесты. Личные переписки не показываются.",
    }),
    status,
    refreshButton,
    listNode,
    el("h2", { class: "section", text: "Выбранные" }),
    el("p", {
      class: "small muted",
      text: selected.length
        ? `${channelCount(selected.length)} · тап по строке меняет стиль и период`
        : "Отметьте чаты выше.",
    }),
    selectedBlock,
    snapshot.dialogs?.updated_at
      ? el("p", { class: "small muted", text: `Список чатов обновлён ${formatMoment(snapshot.dialogs.updated_at)}` })
      : null,
  ]);

  return { title: "Каналы", node };
}
