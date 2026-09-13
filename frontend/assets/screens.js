/**
 * The application screens, beyond the setup wizard.
 *
 * Each screen is a function returning a DOM node, so switching tabs is just a re-render.
 * Nothing here inserts foreign HTML except the digest preview, which goes through
 * `sanitizeHtml` first; the brief view is built from structured topics instead, so it
 * never needs to trust markup at all.
 */

import { el, field, setStatus, statusLine } from "./dom.js";
import { sanitizeHtml } from "./sanitize.js";
import { sendToBot } from "./telegram.js";
import {
  PATHS,
  briefTopics,
  digestFileName,
  formatDate,
  formatMoment,
  formatTokens,
  formatUsd,
  usageByDay,
} from "./state.js";

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
