/**
 * The application screens, beyond the setup wizard.
 *
 * Each screen is a function returning a DOM node, so switching tabs is just a re-render.
 * Nothing here inserts foreign HTML except the digest preview, which goes through
 * `sanitizeHtml` first; the brief view is built from structured topics instead, so it
 * never needs to trust markup at all.
 */

import { el, checkboxField, field, selectField, setStatus, statusLine, textareaField } from "./dom.js";
import { sanitizeHtml } from "./sanitize.js";
import { sendToBot } from "./telegram.js";
import {
  PATHS,
  briefTopics,
  dialogToChannel,
  digestFileName,
  formatDate,
  formatMoment,
  formatTokens,
  formatUsd,
  isNewerThan,
  selectableDialogs,
  usageByDay,
} from "./state.js";

/** The system prompt keys the backend hardcodes; the UI cannot add new ones. */
export const PROMPT_KEYS = [
  { value: "summary_brief", label: "Краткий" },
  { value: "summary_detailed", label: "Детальный" },
  { value: "summary_analytical", label: "Аналитический" },
];

/** Grouping strategies the renderer and the model understand. */
export const GROUPINGS = [
  { value: "topics", label: "По форум-топикам" },
  { value: "llm", label: "По темам (определяет модель)" },
  { value: "dates", label: "По датам" },
  { value: "channels", label: "По каналам" },
];

/** Sections a template may ask for; mirrors ALLOWED_SECTIONS in the renderer. */
export const SECTIONS = [
  { value: "summary", label: "Сводка по темам" },
  { value: "meta", label: "Строка с числом сообщений и стоимостью" },
];

/** Longest style prompt the backend accepts. */
export const MAX_STYLE_CHARS = 2000;

/** Write a collection envelope, keeping the schema shape. */
async function saveList(client, path, sha, items, message) {
  await client.writeJson(
    path,
    { schema: 1, updated_at: new Date().toISOString(), items },
    message,
    sha,
  );
}

/** The next free id in a collection. */
function nextId(items) {
  return items.reduce((max, item) => Math.max(max, Number(item.id ?? 0)), 0) + 1;
}

/** A section header with an optional subtitle. */
function header(title, subtitle) {
  return el("div", {}, [
    el("h1", { text: title }),
    subtitle ? el("p", { class: "lede", text: subtitle }) : null,
  ]);
}

/** Trigger a client-side file download. */
export function downloadText(filename, text, mime = "text/markdown;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * The digest screen: pick a digest, read it briefly or in full, resend it, download it.
 *
 * @param {object} options
 * @param {object} options.snapshot
 * @param {object} options.client
 */
export function createDigestScreen({ snapshot, client }) {
  const status = statusLine();
  let selectedId = snapshot.digests[0]?.id ?? null;
  let mode = "detailed";
  let loaded = null;
  const body = el("div", { class: "digest" });

  const render = async () => {
    body.replaceChildren();
    if (!selectedId) {
      body.append(el("p", { class: "muted", text: "Дайджестов пока нет." }));
      return;
    }
    loaded = (await client.readJson(`data/digests/${selectedId}.json`))?.data ?? null;
    if (!loaded) {
      body.append(el("p", { class: "status status--error", text: "Файл дайджеста не найден." }));
      return;
    }

    const topics = mode === "brief" ? briefTopics(loaded.topics) : loaded.topics;
    if (mode === "brief") {
      // Built from data, so there is no markup to sanitise in the first place.
      body.append(el("h2", { text: loaded.channel_title }));
      for (const topic of topics) {
        body.append(el("h3", { text: topic.title }));
        body.append(el("ul", {}, topic.bullets.map((bullet) => el("li", { text: bullet }))));
      }
    } else {
      // The backend already reduced this to a tag whitelist; sanitising again means a bug
      // in the backend cannot become script execution here.
      body.append(sanitizeHtml(loaded.html ?? ""));
    }

    body.append(
      el("p", {
        class: "muted",
        text: `Период: ${formatMoment(loaded.period_start)} — ${formatMoment(loaded.period_end)} · ${formatUsd(loaded.usage?.cost_usd ?? 0)}`,
      }),
    );
  };

  const list = el(
    "ul",
    { class: "list" },
    snapshot.digests.slice(0, 30).map((item) =>
      el("li", { class: "list__item" }, [
        el("div", {}, [
          el("span", { class: "list__title", text: item.channel_title }),
          el("span", {
            class: "list__sub",
            text: ` ${formatMoment(item.period_end)} · ${item.messages_used} сообщений`,
          }),
        ]),
        el("button", {
          class: "button",
          type: "button",
          text: item.id === selectedId ? "Выбран" : "Открыть",
          on: {
            click: async () => {
              selectedId = item.id;
              await render();
            },
          },
        }),
      ]),
    ),
  );

  const controls = el("div", { class: "row" }, [
    el("button", {
      class: "button",
      type: "button",
      text: "Краткий",
      on: {
        click: async () => {
          mode = "brief";
          await render();
        },
      },
    }),
    el("button", {
      class: "button",
      type: "button",
      text: "Детальный",
      on: {
        click: async () => {
          mode = "detailed";
          await render();
        },
      },
    }),
    el("button", {
      class: "button",
      type: "button",
      text: "Скачать Markdown",
      on: {
        click: () => {
          if (!loaded) {
            setStatus(status, "Сначала откройте дайджест.", "warn");
            return;
          }
          downloadText(digestFileName(loaded), loaded.markdown ?? "");
          setStatus(status, "Файл сохранён.", "ok");
        },
      },
    }),
    el("button", {
      class: "button button--primary",
      type: "button",
      text: "Отправить в бот",
      on: {
        click: async (event) => {
          const button = event.currentTarget;
          const token = snapshot.settings?.values?.telegram?.bot_token ?? "";
          const chatId = snapshot.settings?.values?.telegram?.chat_id ?? "";
          if (!loaded) {
            setStatus(status, "Сначала откройте дайджест.", "warn");
            return;
          }
          button.disabled = true;
          try {
            setStatus(status, "Отправляю…");
            const ids = await sendToBot({
              token,
              chatId,
              // The stored Telegram markup is what the pipeline delivered, so a resend
              // looks identical instead of re-rendering slightly differently.
              markup: loaded.telegram_html || loaded.markdown,
            });
            setStatus(status, `Отправлено: ${ids.length} сообщени${ids.length === 1 ? "е" : "й"}.`, "ok");
          } catch (error) {
            setStatus(status, error.message, "error");
          } finally {
            button.disabled = false;
          }
        },
      },
    }),
  ]);

  render();

  return el("section", { class: "card" }, [
    header("Дайджесты", "Краткий вид — по два тезиса на тему, детальный — как отправили в Telegram."),
    list,
    controls,
    status,
    body,
  ]);
}

/** Poll a probe until it answers or the deadline passes. */
async function pollUntil(probe, { intervalMs = 4000, timeoutMs = 150_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result) {
      return result;
    }
    if (Date.now() > deadline) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * A reusable "add a channel" block: pick one of the account's chats, or type it in.
 *
 * The chat directory comes from the telegram-list workflow, which stores it in the private
 * branch — so the user never has to know a numeric id.
 *
 * @param {object} options
 * @param {object} options.snapshot
 * @param {object} options.client
 * @param {Function} [options.onAdded] called after a successful add
 * @param {HTMLElement} [options.status] shared status line, when the caller has one
 */
export function createChannelAdder({ snapshot, client, onAdded, status: shared }) {
  const status = shared ?? statusLine();
  const title = field({ label: "Название", placeholder: "Как называть в интерфейсе" });
  const reference = field({
    label: "Username или id",
    placeholder: "@channel или -1001234567890",
    hint: "для приватных каналов — числовой id",
  });
  const type = selectField({
    label: "Тип",
    value: "channel",
    options: [
      { value: "channel", label: "Канал" },
      { value: "group", label: "Группа" },
      { value: "forum", label: "Форум с топиками" },
      { value: "user", label: "Личный чат" },
    ],
  });
  const period = field({ label: "Период по умолчанию, часов", type: "number", value: "24" });
  const picker = el("div", { class: "picker" });

  /** Fill the manual fields from a chat in the directory. */
  const choose = (item) => {
    const picked = dialogToChannel(item);
    title.input.value = picked.title;
    reference.input.value = picked.username ? `@${picked.username}` : picked.title && picked.tg_id;
    type.input.value = picked.type;
    setStatus(status, `Выбран чат «${picked.title}». Проверьте период и нажмите «Добавить».`, "info");
  };

  /** Render the chat dropdown from the stored directory. */
  const renderPicker = async () => {
    picker.replaceChildren();
    const stored = await client.readJson(PATHS.dialogs);
    const items = selectableDialogs(stored?.data?.items);
    if (!items.length) {
      picker.append(
        el("p", { class: "muted", text: "Список чатов ещё не собран — нажмите «Обновить список чатов»." }),
      );
      return;
    }
    picker.append(
      el("label", { class: "field" }, [
        el("span", { class: "field__label", text: "Выбрать из моих чатов" }),
        el(
          "select",
          {
            class: "input",
            on: {
              change: (event) => {
                const item = items[Number(event.target.value)];
                if (item) {
                  choose(item);
                }
              },
            },
          },
          [
            el("option", { value: "", text: `— выберите из ${items.length} чатов —` }),
            ...items.map((item, index) =>
              el("option", {
                value: String(index),
                text: `${item.is_forum ? "▸ " : ""}${item.title} (${item.type})`,
              }),
            ),
          ],
        ),
      ]),
    );
  };

  const refreshChats = el("button", {
    class: "button",
    type: "button",
    text: "Обновить список чатов",
    on: {
      click: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          setStatus(status, "Запрашиваю список чатов из Telegram…");
          const startedAt = Date.now();
          await client.dispatch("telegram-list.yml", { mode: "dialogs", limit: "300" });
          const ready = await pollUntil(async () => {
            const stored = await client.readJson(PATHS.dialogs);
            return isNewerThan(stored?.data, startedAt) ? stored.data : null;
          });
          if (!ready) {
            throw new Error("список не собрался за две минуты — посмотрите Actions → telegram-list");
          }
          setStatus(status, `Получено чатов: ${ready.items.length}.`, "ok");
          await renderPicker();
        } catch (error) {
          setStatus(status, error.message, "error");
        } finally {
          button.disabled = false;
        }
      },
    },
  });

  const add = el("button", {
    class: "button button--primary",
    type: "button",
    text: "Добавить канал",
    on: {
      click: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const raw = reference.input.value.trim();
          if (!title.input.value.trim() || !raw) {
            throw new Error("заполните название и ссылку");
          }
          const username = raw.startsWith("@") ? raw.slice(1) : "";
          const numeric = raw.replace(/^@/, "");
          const tgId = /^-?\d+$/.test(numeric) ? numeric : null;
          if (!username && !tgId) {
            throw new Error("укажите @username или числовой id");
          }

          const record = buildChannel(
            snapshot.channels,
            {
              title: title.input.value.trim(),
              username,
              tg_id: tgId ?? numeric,
              type: type.input.value,
              has_topics: type.input.value === "forum",
              default_period_hours: Number(period.input.value || 24),
            },
            new Date().toISOString(),
          );
          setStatus(status, "Сохраняю…");
          await saveList(
            client,
            PATHS.channels,
            snapshot.channelsSha,
            [...snapshot.channels, record],
            `feat(channels): add ${record.title}`,
          );
          setStatus(status, `Канал «${record.title}» добавлен.`, "ok");
          if (onAdded) {
            await onAdded();
          }
        } catch (error) {
          setStatus(status, error.message, "error");
        } finally {
          button.disabled = false;
        }
      },
    },
  });

  renderPicker();

  return el("div", { class: "subcard" }, [
    el("strong", { text: "Добавить канал" }),
    el("p", { class: "muted", text: "Список чатов берётся из вашего аккаунта." }),
    picker,
    refreshChats,
    title.field,
    reference.field,
    type.field,
    period.field,
    add,
    shared ? null : status,
  ]);
}

/**
 * The settings screen: budget, soft limits and channel management.
 *
 * @param {object} options
 * @param {object} options.snapshot
 * @param {object} options.client
 * @param {Function} options.refresh reload everything after a change
 */
export function createSettingsScreen({ snapshot, client, refresh }) {
  const status = statusLine();
  const values = snapshot.settings?.values ?? {};
  const budget = values.budget ?? {};
  const telegram = values.telegram ?? {};

  const monthly = field({
    label: "Бюджет, $/мес",
    type: "number",
    value: String(budget.monthly_usd ?? 5),
    hint: "при достижении лимита новые дайджесты блокируются",
  });
  const warnRatio = field({
    label: "Порог предупреждения",
    type: "number",
    value: String(budget.warn_ratio ?? 0.8),
    hint: "доля бюджета, после которой интерфейс предупреждает",
  });
  const maxPerDay = field({
    label: "Дайджестов в сутки",
    type: "number",
    value: String(telegram.max_digests_per_day ?? 50),
  });
  const maxPerHour = field({
    label: "Дайджестов в час",
    type: "number",
    value: String(telegram.max_requests_per_hour ?? 10),
  });
  const maxTokens = field({
    label: "Максимум токенов ответа",
    type: "number",
    value: String(values.llm?.max_output_tokens ?? 8192),
  });

  const save = async () => {
    try {
      const merged = {
        ...(snapshot.settings ?? { schema: 1 }),
        schema: snapshot.settings?.schema ?? 1,
        updated_at: new Date().toISOString(),
        values: {
          ...values,
          budget: {
            monthly_usd: Number(monthly.input.value),
            warn_ratio: Number(warnRatio.input.value),
          },
          telegram: {
            ...telegram,
            max_digests_per_day: Number(maxPerDay.input.value),
            max_requests_per_hour: Number(maxPerHour.input.value),
          },
          llm: { ...(values.llm ?? {}), max_output_tokens: Number(maxTokens.input.value) },
        },
      };
      await client.writeJson(PATHS.settings, merged, "feat(settings): update limits", snapshot.settingsSha);
      setStatus(status, "Сохранено.", "ok");
      await refresh();
    } catch (error) {
      setStatus(status, error.message, "error");
    }
  };

  const removeChannel = (channel) => async () => {
    try {
      const remaining = snapshot.channels.filter((entry) => entry.id !== channel.id);
      await client.writeJson(
        PATHS.channels,
        { schema: 1, updated_at: new Date().toISOString(), items: remaining },
        `feat(channels): remove ${channel.id}`,
        snapshot.channelsSha,
      );
      setStatus(status, `Канал «${channel.title}» удалён.`, "ok");
      await refresh();
    } catch (error) {
      setStatus(status, error.message, "error");
    }
  };

  return el("section", { class: "card" }, [
    header("Настройки", "Бюджет, лимиты и список источников."),
    monthly.field,
    warnRatio.field,
    maxTokens.field,
    maxPerDay.field,
    maxPerHour.field,
    el("button", {
      class: "button button--primary",
      type: "button",
      text: "Сохранить",
      on: { click: save },
    }),
    status,
    el("h2", { text: "Каналы" }),
    createChannelAdder({ snapshot, client, onAdded: refresh, status }),
    el(
      "ul",
      { class: "list" },
      snapshot.channels.map((channel) =>
        el("li", { class: "list__item" }, [
          el("div", {}, [
            el("span", { class: "list__title", text: channel.title }),
            el("span", {
              class: "list__sub",
              text: ` ${channel.type} · ${channel.default_period_hours} ч · ${
                channel.username ? `@${channel.username}` : channel.tg_id
              }`,
            }),
          ]),
          el("button", {
            class: "button",
            type: "button",
            text: "Удалить",
            on: { click: removeChannel(channel) },
          }),
        ]),
      ),
    ),
  ]);
}

/**
 * The statistics screen: spending by day for the current month.
 *
 * @param {object} options
 * @param {object} options.snapshot
 */
export function createStatsScreen({ snapshot }) {
  const days = usageByDay(snapshot.usage);
  const totals = snapshot.usage?.totals ?? {};

  const table = el("table", { class: "table" }, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", { text: "День" }),
        el("th", { text: "Дайджестов" }),
        el("th", { text: "Токены in" }),
        el("th", { text: "Токены out" }),
        el("th", { text: "Из кэша" }),
        el("th", { text: "Стоимость" }),
      ]),
    ]),
    el(
      "tbody",
      {},
      days.map((day) =>
        el("tr", {}, [
          el("td", { text: formatDate(day.date) }),
          el("td", { text: String(day.digests) }),
          el("td", { text: formatTokens(day.tokensIn) }),
          el("td", { text: formatTokens(day.tokensOut) }),
          el("td", { text: formatTokens(day.cacheHitTokens) }),
          el("td", { text: formatUsd(day.costUsd) }),
        ]),
      ),
    ),
    el("tfoot", {}, [
      el("tr", {}, [
        el("th", { text: `Итого за ${snapshot.month}` }),
        el("th", { text: String(totals.digests ?? 0) }),
        el("th", { text: formatTokens(totals.tokens_in ?? 0) }),
        el("th", { text: formatTokens(totals.tokens_out ?? 0) }),
        el("th", { text: formatTokens(totals.cache_hit_tokens ?? 0) }),
        el("th", { text: formatUsd(totals.cost_usd ?? 0) }),
      ]),
    ]),
  ]);

  return el("section", { class: "card" }, [
    header("Статистика LLM", "Токены и стоимость по дням текущего месяца."),
    days.length
      ? el("div", { class: "table-wrap" }, [table])
      : el("p", { class: "muted", text: "В этом месяце ещё ничего не потрачено." }),
  ]);
}

/**
 * The templates and presets screen.
 *
 * Presets decide *what* the model is asked for (the style text is wrapped in `<<STYLE>>`
 * by the backend); templates decide *how* the answer is laid out. Both are stored in the
 * data branch, so an edit here is an edit for every browser.
 *
 * @param {object} options
 * @param {object} options.snapshot
 * @param {object} options.client
 * @param {Function} options.refresh
 */
export function createTemplatesScreen({ snapshot, client, refresh }) {
  const status = statusLine();
  const preview = el("div", { class: "digest preview" });

  /** Render a sample digest from the template currently being edited. */
  const renderPreview = (draft) => {
    preview.replaceChildren();
    const title = String(draft.title_template || "# Дайджест: {channel} — {period}")
      .replace("{channel}", "Пример канала")
      .replace("{period}", "12.09 12:00 — 13.09 12:00 UTC")
      .replace(/^#+\s*/, "");

    preview.append(el("h1", { text: title }));
    const sections = draft.sections ?? [];
    const topics = [
      { title: "Тарифы", bullets: ["Цена выросла на 10%", "Добавили ночной тариф"] },
      { title: "Логистика", bullets: ["Сроки сдвинулись на неделю"] },
    ];

    if (sections.includes("summary")) {
      for (const topic of topics) {
        preview.append(el("h2", { text: topic.title }));
        preview.append(el("ul", {}, topic.bullets.map((bullet) => el("li", { text: bullet }))));
      }
    } else {
      preview.append(el("p", { class: "muted", text: "Секция «Сводка по темам» выключена:" }));
      preview.append(el("ul", {}, topics.map((topic) => el("li", { text: topic.title }))));
    }

    if (sections.includes("meta")) {
      preview.append(el("hr"));
      preview.append(el("p", { class: "muted", text: "сообщений: 412 · стоимость: $0.0136" }));
    }
  };

  /** One preset editor. */
  const presetForm = (preset, presets) => {
    const name = field({ label: "Название", value: preset.name });
    const promptKey = selectField({
      label: "Системный промпт",
      value: preset.system_prompt_key,
      options: PROMPT_KEYS,
      hint: "тексты промптов захардкожены в backend/prompts.py и из интерфейса не меняются",
    });
    const style = textareaField({
      label: "Стилевые указания",
      value: preset.user_prompt_style ?? "",
      rows: 4,
      maxlength: MAX_STYLE_CHARS,
      hint: `до ${MAX_STYLE_CHARS} символов; это стиль, а не команды — backend оборачивает его в блок <<STYLE>>`,
    });
    const isDefault = checkboxField({ label: "Использовать по умолчанию", checked: Boolean(preset.is_default) });

    const save = async () => {
      try {
        const updated = presets.map((entry) =>
          entry.id === preset.id
            ? {
                ...entry,
                name: name.input.value.trim() || entry.name,
                system_prompt_key: promptKey.input.value,
                user_prompt_style: style.input.value,
                is_default: isDefault.input.checked ? 1 : 0,
              }
            : isDefault.input.checked
              ? { ...entry, is_default: 0 }
              : entry,
        );
        await saveList(client, PATHS.presets, snapshot.presetsSha, updated, `feat(presets): update ${preset.name}`);
        setStatus(status, "Пресет сохранён.", "ok");
        await refresh();
      } catch (error) {
        setStatus(status, error.message, "error");
      }
    };

    const remove = async () => {
      try {
        const remaining = presets.filter((entry) => entry.id !== preset.id);
        await saveList(client, PATHS.presets, snapshot.presetsSha, remaining, `feat(presets): remove ${preset.id}`);
        setStatus(status, "Пресет удалён.", "ok");
        await refresh();
      } catch (error) {
        setStatus(status, error.message, "error");
      }
    };

    return el("div", { class: "subcard" }, [
      el("div", { class: "row" }, [
        el("strong", { text: preset.name }),
        el("button", { class: "button", type: "button", text: "Сохранить", on: { click: save } }),
        el("button", { class: "button button--link", type: "button", text: "Удалить", on: { click: remove } }),
      ]),
      name.field,
      promptKey.field,
      style.field,
      isDefault.field,
    ]);
  };

  /** One template editor with a live preview. */
  const templateForm = (template, templates) => {
    const name = field({ label: "Название", value: template.name });
    const grouping = selectField({
      label: "Группировка",
      value: template.grouping,
      options: GROUPINGS,
    });
    const title = field({
      label: "Шаблон заголовка",
      value: template.title_template,
      hint: "доступны {channel} и {period}; неизвестные подстановки останутся как есть",
    });

    const sectionBoxes = SECTIONS.map((section) => ({
      section,
      box: checkboxField({
        label: section.label,
        checked: (template.sections ?? []).includes(section.value),
      }),
    }));

    const draft = () => ({
      title_template: title.input.value,
      sections: sectionBoxes.filter((entry) => entry.box.input.checked).map((entry) => entry.section.value),
    });

    for (const entry of sectionBoxes) {
      entry.box.input.addEventListener("change", () => renderPreview(draft()));
    }
    title.input.addEventListener("input", () => renderPreview(draft()));

    const save = async () => {
      try {
        const updated = templates.map((entry) =>
          entry.id === template.id
            ? {
                ...entry,
                name: name.input.value.trim() || entry.name,
                grouping: grouping.input.value,
                title_template: title.input.value,
                sections: draft().sections,
              }
            : entry,
        );
        await saveList(client, PATHS.templates, snapshot.templatesSha, updated, `feat(templates): update ${template.name}`);
        setStatus(status, "Шаблон сохранён.", "ok");
        await refresh();
      } catch (error) {
        setStatus(status, error.message, "error");
      }
    };

    const remove = async () => {
      try {
        const remaining = templates.filter((entry) => entry.id !== template.id);
        await saveList(client, PATHS.templates, snapshot.templatesSha, remaining, `feat(templates): remove ${template.id}`);
        setStatus(status, "Шаблон удалён.", "ok");
        await refresh();
      } catch (error) {
        setStatus(status, error.message, "error");
      }
    };

    return el("div", { class: "subcard" }, [
      el("div", { class: "row" }, [
        el("strong", { text: template.name }),
        el("button", { class: "button", type: "button", text: "Сохранить", on: { click: save } }),
        el("button", { class: "button button--link", type: "button", text: "Удалить", on: { click: remove } }),
      ]),
      name.field,
      grouping.field,
      title.field,
      ...sectionBoxes.map((entry) => entry.box.field),
    ]);
  };

  /** Assign a preset and a period to each channel. */
  const channelRow = (channel) => {
    const preset = selectField({
      label: channel.title,
      value: String(channel.summary_style_id ?? ""),
      options: [
        { value: "", label: "Пресет по умолчанию" },
        ...snapshot.presets.map((entry) => ({ value: String(entry.id), label: entry.name })),
      ],
    });
    const period = field({
      label: "Период, часов",
      type: "number",
      value: String(channel.default_period_hours ?? 24),
    });

    const save = async () => {
      try {
        const updated = snapshot.channels.map((entry) =>
          entry.id === channel.id
            ? {
                ...entry,
                summary_style_id: preset.input.value ? Number(preset.input.value) : null,
                default_period_hours: Number(period.input.value || 24),
              }
            : entry,
        );
        await saveList(client, PATHS.channels, snapshot.channelsSha, updated, `feat(channels): tune ${channel.id}`);
        setStatus(status, `Канал «${channel.title}» обновлён.`, "ok");
        await refresh();
      } catch (error) {
        setStatus(status, error.message, "error");
      }
    };

    return el("div", { class: "subcard" }, [
      preset.field,
      period.field,
      el("button", { class: "button", type: "button", text: "Сохранить", on: { click: save } }),
    ]);
  };

  const addPreset = async () => {
    try {
      const id = nextId(snapshot.presets);
      const updated = [
        ...snapshot.presets,
        {
          id,
          name: `Пресет ${id}`,
          system_prompt_key: "summary_brief",
          user_prompt_style: "",
          is_default: 0,
          created_at: new Date().toISOString(),
        },
      ];
      await saveList(client, PATHS.presets, snapshot.presetsSha, updated, "feat(presets): add");
      await refresh();
    } catch (error) {
      setStatus(status, error.message, "error");
    }
  };

  const addTemplate = async () => {
    try {
      const id = nextId(snapshot.templates);
      const updated = [
        ...snapshot.templates,
        {
          id,
          name: `Шаблон ${id}`,
          grouping: "topics",
          sections: ["summary"],
          title_template: "# Дайджест: {channel} — {period}",
          is_default: 0,
          created_at: new Date().toISOString(),
        },
      ];
      await saveList(client, PATHS.templates, snapshot.templatesSha, updated, "feat(templates): add");
      await refresh();
    } catch (error) {
      setStatus(status, error.message, "error");
    }
  };

  renderPreview(snapshot.templates[0] ?? { title_template: "", sections: ["summary"] });

  return el("section", { class: "card" }, [
    header("Шаблоны и пресеты", "Пресет задаёт стиль сводки, шаблон — её вид."),
    status,
    el("h2", { text: "Пресеты" }),
    ...snapshot.presets.map((preset) => presetForm(preset, snapshot.presets)),
    el("button", { class: "button", type: "button", text: "Добавить пресет", on: { click: addPreset } }),

    el("h2", { text: "Каналы" }),
    snapshot.channels.length
      ? el("div", {}, snapshot.channels.map((channel) => channelRow(channel)))
      : el("p", { class: "muted", text: "Каналов пока нет." }),

    el("h2", { text: "Шаблоны" }),
    ...snapshot.templates.map((template) => templateForm(template, snapshot.templates)),
    el("button", { class: "button", type: "button", text: "Добавить шаблон", on: { click: addTemplate } }),

    el("h2", { text: "Превью" }),
    preview,
  ]);
}
