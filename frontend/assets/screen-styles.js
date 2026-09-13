/**
 * Styles and layouts: the settings list, and the editors behind it.
 *
 * The two live together because they answer the same question from two sides. A *style*
 * decides how the model writes — every run writes all of them, so the reader switches
 * between versions of the same digest. A *layout* decides how the result is arranged —
 * a run writes one document, so it is chosen before the run starts.
 *
 * One style is in use at a time — the one marked as main — and the digest screen shows it
 * whole, so this list is where the style is chosen rather than a switch inside a digest.
 *
 * A style's dictated text goes into `user_prompt_style`, which the backend wraps in a
 * `<<STYLE>>` block marked as style rather than instructions. The *system* prompt itself
 * stays hardcoded in `backend/prompts.py` and cannot be edited from a page: a text box that
 * could rewrite it would be a text box that could rewrite the safety rules with it. The
 * editor therefore offers the three built-in bases to build on, and takes free text only
 * for the part that is meant to be free.
 */

import { el, field, setStatus, statusLine, textareaField } from "./dom.js";
import { PATHS } from "./state.js";
import { actionButton, button, createSheet, listRow, toast } from "./ui.js";

/** The three hardcoded prompts a custom style can be built on. */
export const STYLE_BASES = [
  { key: "summary_brief", label: "Краткий" },
  { key: "summary_detailed", label: "Детальный" },
  { key: "summary_analytical", label: "Аналитический" },
];

/** How a layout can arrange the digest. */
export const GROUPINGS = [
  { value: "topics", label: "По темам канала", hint: "топики форума, как их назвал канал" },
  { value: "llm", label: "По темам от модели", hint: "модель сама решает, какие темы есть" },
  { value: "dates", label: "По дням", hint: "блок на каждый день периода" },
];

/** The longest style text the backend accepts, mirrored so the box cannot overflow it. */
const MAX_STYLE_CHARS = 2000;

/** One line describing a layout, for the list. */
export function describeTemplate(template) {
  const grouping = GROUPINGS.find((entry) => entry.value === template?.grouping);
  const parts = [grouping?.label ?? template?.grouping ?? "темы"];
  const sections = template?.sections ?? [];
  parts.push(sections.includes("meta") ? "сводка и итоги" : "только сводка");
  return parts.join(" · ");
}

/** The next free id in a collection, the way `buildChannel` numbers channels. */
export function nextId(items) {
  return (items ?? []).reduce((max, item) => Math.max(max, Number(item?.id ?? 0)), 0) + 1;
}

/**
 * A collection with exactly one default.
 *
 * The backend falls back to the first entry when nothing is marked, so a collection with no
 * default still works — but "по умолчанию" appearing nowhere and acting nowhere is worse
 * than a clear answer.
 */
export function withDefault(items, id) {
  return items.map((item) => ({ ...item, is_default: item.id === id ? 1 : 0 }));
}

/** Insert or replace one entry, keeping the collection in id order. */
export function upsert(items, entry) {
  const list = (items ?? []).filter((item) => item.id !== entry.id);
  return [...list, entry].sort((left, right) => Number(left.id) - Number(right.id));
}

/** Remove one entry, promoting the first survivor to default if the default was removed. */
export function withoutEntry(items, id) {
  const list = (items ?? []).filter((item) => item.id !== id);
  if (list.length && !list.some((item) => item.is_default)) {
    list[0] = { ...list[0], is_default: 1 };
  }
  return list;
}

/** Write presets.json or templates.json against a freshly read sha. */
async function writeCollection(ctx, path, items, message) {
  const stored = await ctx.client.readJson(path);
  await ctx.client.writeJson(
    path,
    { schema: 1, updated_at: new Date().toISOString(), items },
    message,
    stored?.sha ?? null,
  );
  await ctx.refresh({ silent: true });
}

/**
 * The editor for one style.
 *
 * @param {object} ctx screen context
 * @param {object|null} preset an existing style, or null to create one
 */
export function openStyleSheet(ctx, preset) {
  const presets = ctx.snapshot.presets ?? [];
  const isNew = !preset;
  let base = preset?.system_prompt_key ?? STYLE_BASES[0].key;
  let isDefault = Boolean(preset?.is_default);

  const name = field({
    label: "Название",
    value: preset?.name ?? "",
    placeholder: "Например: Сухо и по делу",
    maxlength: 60,
  });
  const prompt = textareaField({
    label: "Как писать",
    value: preset?.user_prompt_style ?? "",
    rows: 5,
    maxlength: MAX_STYLE_CHARS,
    hint: `Это указание уходит модели. Основу промпта задаёт приложение — её нельзя переписать, но можно выбрать.`,
    placeholder: "Пиши сухо, без вступлений. Сохраняй цифры и даты. Не больше трёх пунктов на тему.",
  });

  const status = statusLine();
  const baseChips = el("div", { class: "chips" });
  const baseNodes = [];

  const paintBases = () => {
    for (const entry of baseNodes) {
      entry.node.classList.toggle("chip--on", entry.key === base);
    }
  };

  const defaultTrack = el("span", { class: `switch${isDefault ? " switch--on" : ""}` });
  const defaultRow = el(
    "button",
    {
      class: "switchrow",
      type: "button",
      "aria-pressed": isDefault ? "true" : "false",
      on: {
        click: () => {
          isDefault = !isDefault;
          defaultTrack.classList.toggle("switch--on", isDefault);
          defaultRow.setAttribute("aria-pressed", isDefault ? "true" : "false");
        },
      },
    },
    [
      el("span", { class: "switchrow__body" }, [
        el("span", { class: "switchrow__title", text: "Основной стиль" }),
        el("span", {
          class: "switchrow__sub",
          text: "Открывается первым в дайджесте",
        }),
      ]),
      defaultTrack,
    ],
  );

  const save = actionButton({
    label: isNew ? "Добавить стиль" : "Сохранить",
    variant: "primary",
    block: true,
    busyLabel: "Сохраняю…",
    action: async () => {
      const title = name.input.value.trim();
      const text = prompt.input.value.trim();
      if (!title) {
        setStatus(status, "Название не может быть пустым.", "error");
        return;
      }
      try {
        const entry = {
          id: preset?.id ?? nextId(presets),
          name: title,
          system_prompt_key: base,
          user_prompt_style: text,
          is_default: isDefault ? 1 : 0,
          created_at: preset?.created_at ?? new Date().toISOString(),
        };
        let items = upsert(presets, entry);
        // Exactly one default: the switch turns itself on and everything else off.
        items = isDefault ? withDefault(items, entry.id) : items;
        if (!items.some((item) => item.is_default) && items.length) {
          items = withDefault(items, items[0].id);
        }
        await writeCollection(ctx, PATHS.presets, items, `chore(styles): ${title}`);
        sheet.close();
        toast(isNew ? "Стиль добавлен" : "Стиль сохранён", "ok");
      } catch (error) {
        setStatus(status, error.message, "error");
      }
    },
  });

  const body = [
    el("p", {
      class: "small muted",
      text: "Каждый прогон пишет все стили сразу, поэтому добавленный стиль появится в каждом новом дайджесте.",
    }),
    name.field,
    el("h3", { class: "small muted", text: "Основа" }),
    baseChips,
    prompt.field,
    el("div", { class: "card card--flush" }, [defaultRow]),
    save,
    status,
  ];

  if (!isNew && presets.length > 1) {
    body.push(
      button({
        label: "Удалить стиль",
        variant: "danger",
        block: true,
        onClick: async () => {
          try {
            await writeCollection(
              ctx,
              PATHS.presets,
              withoutEntry(presets, preset.id),
              `chore(styles): remove ${preset.name}`,
            );
            sheet.close();
            toast("Стиль удалён", "ok");
          } catch (error) {
            setStatus(status, error.message, "error");
          }
        },
      }),
    );
  }

  const sheet = createSheet({ title: isNew ? "Свой стиль" : preset.name, body });

  for (const entry of STYLE_BASES) {
    const node = el("button", {
      class: "chip",
      type: "button",
      text: entry.label,
      on: {
        click: () => {
          base = entry.key;
          paintBases();
        },
      },
    });
    baseNodes.push({ node, key: entry.key });
    baseChips.append(node);
  }
  paintBases();

  sheet.open();
  return sheet;
}

/**
 * The editor for one layout.
 *
 * @param {object} ctx screen context
 * @param {object|null} template an existing layout, or null to create one
 */
export function openTemplateSheet(ctx, template) {
  const templates = ctx.snapshot.templates ?? [];
  const isNew = !template;
  let grouping = template?.grouping ?? "topics";
  let withMeta = (template?.sections ?? []).includes("meta");
  let isDefault = Boolean(template?.is_default);

  const name = field({
    label: "Название",
    value: template?.name ?? "",
    placeholder: "Например: Только цифры",
    maxlength: 60,
  });
  const title = field({
    label: "Заголовок дайджеста",
    value: template?.title_template ?? "# Дайджест: {channel} — {period}",
    hint: "{channel} — название канала, {period} — период. Другие подстановки останутся как есть.",
    maxlength: 200,
  });

  const status = statusLine();
  const groupingChips = el("div", { class: "chips" });
  const groupingNodes = [];
  const groupingHint = el("p", { class: "small muted" });

  const paintGrouping = () => {
    for (const entry of groupingNodes) {
      entry.node.classList.toggle("chip--on", entry.value === grouping);
    }
    groupingHint.textContent = GROUPINGS.find((entry) => entry.value === grouping)?.hint ?? "";
  };

  const metaTrack = el("span", { class: `switch${withMeta ? " switch--on" : ""}` });
  const metaRow = el(
    "button",
    {
      class: "switchrow",
      type: "button",
      "aria-pressed": withMeta ? "true" : "false",
      on: {
        click: () => {
          withMeta = !withMeta;
          metaTrack.classList.toggle("switch--on", withMeta);
          metaRow.setAttribute("aria-pressed", withMeta ? "true" : "false");
        },
      },
    },
    [
      el("span", { class: "switchrow__body" }, [
        el("span", { class: "switchrow__title", text: "Добавлять итоги" }),
        el("span", {
          class: "switchrow__sub",
          text: "Сколько сообщений вошло в дайджест и во сколько он обошёлся",
        }),
      ]),
      metaTrack,
    ],
  );

  const defaultTrack = el("span", { class: `switch${isDefault ? " switch--on" : ""}` });
  const defaultRow = el(
    "button",
    {
      class: "switchrow",
      type: "button",
      "aria-pressed": isDefault ? "true" : "false",
      on: {
        click: () => {
          isDefault = !isDefault;
          defaultTrack.classList.toggle("switch--on", isDefault);
          defaultRow.setAttribute("aria-pressed", isDefault ? "true" : "false");
        },
      },
    },
    [
      el("span", { class: "switchrow__body" }, [
        el("span", { class: "switchrow__title", text: "Шаблон по умолчанию" }),
        el("span", { class: "switchrow__sub", text: "Предлагается при сборке дайджеста" }),
      ]),
      defaultTrack,
    ],
  );

  const save = actionButton({
    label: isNew ? "Добавить шаблон" : "Сохранить",
    variant: "primary",
    block: true,
    busyLabel: "Сохраняю…",
    action: async () => {
      const title_ = name.input.value.trim();
      if (!title_) {
        setStatus(status, "Название не может быть пустым.", "error");
        return;
      }
      try {
        const entry = {
          id: template?.id ?? nextId(templates),
          name: title_,
          grouping,
          sections: withMeta ? ["summary", "meta"] : ["summary"],
          title_template: title.input.value.trim() || "# Дайджест: {channel} — {period}",
          is_default: isDefault ? 1 : 0,
          created_at: template?.created_at ?? new Date().toISOString(),
        };
        let items = upsert(templates, entry);
        items = isDefault ? withDefault(items, entry.id) : items;
        if (!items.some((item) => item.is_default) && items.length) {
          items = withDefault(items, items[0].id);
        }
        await writeCollection(ctx, PATHS.templates, items, `chore(layouts): ${title_}`);
        sheet.close();
        toast(isNew ? "Шаблон добавлен" : "Шаблон сохранён", "ok");
      } catch (error) {
        setStatus(status, error.message, "error");
      }
    },
  });

  const body = [
    el("p", {
      class: "small muted",
      text: "Шаблон выбирается при сборке дайджеста: вёрстка одна на документ, в отличие от стиля.",
    }),
    name.field,
    el("h3", { class: "small muted", text: "Группировка" }),
    groupingChips,
    groupingHint,
    title.field,
    el("div", { class: "card card--flush" }, [metaRow, defaultRow]),
    save,
    status,
  ];

  if (!isNew && templates.length > 1) {
    body.push(
      button({
        label: "Удалить шаблон",
        variant: "danger",
        block: true,
        onClick: async () => {
          try {
            await writeCollection(
              ctx,
              PATHS.templates,
              withoutEntry(templates, template.id),
              `chore(layouts): remove ${template.name}`,
            );
            sheet.close();
            toast("Шаблон удалён", "ok");
          } catch (error) {
            setStatus(status, error.message, "error");
          }
        },
      }),
    );
  }

  const sheet = createSheet({ title: isNew ? "Свой шаблон" : template.name, body });

  for (const entry of GROUPINGS) {
    const node = el("button", {
      class: "chip",
      type: "button",
      text: entry.label,
      on: {
        click: () => {
          grouping = entry.value;
          paintGrouping();
        },
      },
    });
    groupingNodes.push({ node, value: entry.value });
    groupingChips.append(node);
  }
  paintGrouping();

  sheet.open();
  return sheet;
}


/**
 * The settings list of styles and layouts.
 *
 * Collapsed by default: it is configuration, not part of the everyday loop, but the reader
 * asked to be able to add a style and to choose a layout, so both lists open editors.
 */
export function templatesAccordion(ctx) {
  const presets = ctx.snapshot.presets ?? [];
  const templates = ctx.snapshot.templates ?? [];

  return el("details", { class: "accordion" }, [
    el("summary", { text: `Шаблоны и стили: ${presets.length} и ${templates.length}` }),
    el("div", { class: "accordion__body" }, [
      el("h3", { class: "small muted", text: "Стиль: как писать" }),
      el("p", {
        class: "small muted",
        // No switching in the app: the digest is always written in the main style and shown
        // whole. This is where that style is chosen — by marking another one as main.
        text: "Приложение пишет дайджест одним стилем — основным. Чтобы сменить стиль, отметьте другой как основной.",
      }),
      presets.length
        ? el(
            "ul",
            { class: "list" },
            presets.map((preset) =>
              el("li", {}, [
                listRow({
                  title: preset.name,
                  sub: preset.user_prompt_style || "без дополнительных указаний",
                  meta: preset.is_default ? "основной" : null,
                  chevron: true,
                  onClick: () => openStyleSheet(ctx, preset),
                }),
              ]),
            ),
          )
        : el("p", { class: "small muted", text: "Стили не заданы." }),
      el("div", { class: "section" }, [
        button({
          label: "Свой стиль",
          icon: "plus",
          block: true,
          onClick: () => openStyleSheet(ctx, null),
        }),
      ]),
      el("h3", { class: "small muted section", text: "Шаблоны вёрстки: как располагать" }),
      el("p", {
        class: "small muted",
        text: "Прогон выбирает один шаблон — он задаётся при сборке дайджеста.",
      }),
      templates.length
        ? el(
            "ul",
            { class: "list" },
            templates.map((template) =>
              el("li", {}, [
                listRow({
                  title: template.name,
                  sub: describeTemplate(template),
                  meta: template.is_default ? "по умолчанию" : null,
                  chevron: true,
                  onClick: () => openTemplateSheet(ctx, template),
                }),
              ]),
            ),
          )
        : el("p", { class: "small muted", text: "Шаблонов нет — применяется стандартный." }),
      el("div", { class: "section" }, [
        button({
          label: "Свой шаблон",
          icon: "plus",
          block: true,
          onClick: () => openTemplateSheet(ctx, null),
        }),
      ]),
    ]),
  ]);
}
