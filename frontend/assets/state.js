/**
 * Application state read from the private data branch, and the setup checklist the
 * wizard renders.
 *
 * Keeping the step logic in one pure function means the wizard, the dashboard and the
 * tests all agree on what "настроено" means, and that it can be tested without a browser.
 */

export const PATHS = {
  settings: "data/settings.json",
  loginState: "data/login/state.json",
  loginRequest: "data/login/request.json",
  dialogs: "data/login/dialogs.json",
  topics: "data/login/topics.json",
  style: "data/style.json",
  channels: "data/channels.json",
  presets: "data/presets.json",
  templates: "data/templates.json",
  digestIndex: "data/digests/index.json",
  setupRun: "data/runs/setup-check.json",
  askRequest: "data/ask/request.json",
  /** Full digest file, ``data/digests/<id>.json``. */
  digest: (id) => `data/digests/${safeId(id, "digest")}.json`,
  /** The answer to one question, ``data/ask/<id>.json``. */
  askAnswer: (id) => `data/ask/${safeId(id, "ask")}.json`,
};

/**
 * Reject an id that could escape its directory.
 *
 * Mirrors the check the backend makes in `config.digest_path`: ids always come from files
 * the app wrote itself, but a path built from data is worth validating anyway.
 */
export function safeId(id, kind = "file") {
  const value = String(id ?? "");
  if (!value || value.includes("/") || value.includes("\\") || value.startsWith(".")) {
    throw new Error(`недопустимый ${kind} id`);
  }
  return value;
}

/** Telegram secrets the app knows how to write. */
export const TELEGRAM_SECRETS = ["TG_API_ID", "TG_API_HASH", "TG_PHONE", "TG_STRING_SESSION"];

/** DeepSeek secret. */
export const DEEPSEEK_SECRET = "DEEPSEEK_API_KEY";

/** Read a file from the data branch, returning its data and sha or nulls. */
async function readOrNull(client, path) {
  const stored = await client.readJson(path);
  return { data: stored?.data ?? null, sha: stored?.sha ?? null };
}

/**
 * Load everything the UI needs in one round of parallel reads.
 * @param {object} client the API client from api.js
 */
export async function loadSnapshot(client, month = monthKey(new Date())) {
  const [settings, login, channels, presets, templates, index, usage, setupRun, dialogs] =
    await Promise.all([
      readOrNull(client, PATHS.settings),
      readOrNull(client, PATHS.loginState),
      readOrNull(client, PATHS.channels),
      readOrNull(client, PATHS.presets),
      readOrNull(client, PATHS.templates),
      readOrNull(client, PATHS.digestIndex),
      readOrNull(client, `data/usage/${month}.json`),
      readOrNull(client, PATHS.setupRun),
      readOrNull(client, PATHS.dialogs),
    ]);

  return {
    settings: settings.data,
    settingsSha: settings.sha,
    login: login.data,
    loginSha: login.sha,
    channels: channels.data?.items ?? [],
    channelsSha: channels.sha,
    presets: presets.data?.items ?? [],
    presetsSha: presets.sha,
    templates: templates.data?.items ?? [],
    templatesSha: templates.sha,
    digests: index.data?.items ?? [],
    digestsSha: index.sha,
    usage: usage.data,
    setupRun: setupRun.data,
    /** The account's chat directory, without message content. */
    dialogs: dialogs.data?.items ?? [],
    dialogsUpdatedAt: dialogs.data?.updated_at ?? null,
    month,
  };
}

/** Return the UTC month key, ``YYYY-MM``. */
export function monthKey(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Secret names as reported by the last setup check.
 *
 * A fine-grained PAT can hold Actions + Contents + Secrets *write* without Secrets *read*;
 * the REST list endpoint then answers 500 and the page has no way to see which secrets
 * exist. `setup.yml` runs with every secret in its environment, so its record is the
 * reliable source — the list endpoint is only a bonus.
 *
 * @param {object|null} setupRun contents of data/runs/setup-check.json
 * @returns {Set<string>}
 */
export function secretsFromSetupRun(setupRun) {
  const found = new Set();
  for (const step of setupRun?.steps ?? []) {
    const match = /^secret ([A-Z0-9_]+)$/.exec(String(step?.name ?? ""));
    if (match && step.status === "ok") {
      found.add(match[1]);
    }
  }
  return found;
}

/**
 * Work out which setup steps are still outstanding.
 *
 * Credentials may come from GitHub Secrets or from the data branch, so both sources are
 * consulted; the branch is what the wizard writes before it can reach Secrets. A secret
 * counts as present when either the REST list or the last setup check says so.
 *
 * @param {object} snapshot result of loadSnapshot
 * @param {string[]} secretNames names the repository reports, when it can be listed
 * @returns {Array<{id: string, title: string, hint: string, done: boolean, hidden: boolean}>}
 */
export function setupSteps(snapshot, secretNames = []) {
  const login = snapshot?.login ?? {};
  const telegram = snapshot?.settings?.values?.telegram ?? {};
  const fromSetup = secretsFromSetupRun(snapshot?.setupRun);
  const has = (name) => secretNames.includes(name) || fromSetup.has(name);

  const codeRequested = login.step === "code_sent";
  const sessionReady = login.step === "authorized" || has("TG_STRING_SESSION");
  const sessionInSecrets = has("TG_STRING_SESSION");
  const deepseekReady = has(DEEPSEEK_SECRET);
  const botReady = Boolean(telegram.bot_token && telegram.chat_id);
  const channelsReady = (snapshot?.channels ?? []).length > 0;

  return [
    {
      id: "telegram-app",
      title: "Приложение Telegram",
      hint: "api_id, api_hash и номер телефона с my.telegram.org",
      // Knowing the app credentials is not the same as being logged in: the login still
      // needs the phone number and a requested code. Treating the secrets as completion
      // sent the wizard straight to a code prompt that nothing had sent.
      done: codeRequested || sessionReady,
      hidden: false,
    },
    {
      id: "telegram-code",
      title: "Код из Telegram",
      hint: "код придёт в приложение Telegram, а не по SMS",
      done: sessionReady,
      // Only meaningful once a code has actually been requested.
      hidden: !codeRequested || sessionReady,
    },
    {
      id: "telegram-session",
      title: "Перенести сессию в Secrets",
      hint: "пока сессия лежит в приватной ветке; её лучше перенести в Secrets",
      done: sessionInSecrets,
      hidden: !sessionReady || sessionInSecrets,
      // The backend reads the session from the branch too, so this is an improvement
      // rather than a requirement.
      optional: true,
    },
    {
      id: "deepseek",
      title: "Ключ DeepSeek",
      hint: "ключ с platform.deepseek.com, проверяется сразу",
      done: deepseekReady,
      hidden: false,
    },
    {
      id: "bot",
      title: "Доставка в Telegram",
      hint: "токен бота от @BotFather и ваш chat_id — чтобы поставить кнопку входа в бот",
      done: botReady,
      hidden: false,
      // A digest is still stored and readable without a bot; refusing to show anything
      // until delivery is configured would be the wrong way round.
      optional: true,
    },
    {
      id: "channels",
      title: "Каналы",
      hint: "хотя бы один канал, группу или личный чат",
      done: channelsReady,
      hidden: false,
    },
  ];
}

/**
 * The steps that still block the application.
 *
 * Optional steps are left out: they improve the setup but the project works without them.
 */
export function pendingSteps(steps) {
  return steps.filter((step) => !step.hidden && !step.done && !step.optional);
}

/** Optional steps the user may still want to do. */
export function optionalSteps(steps) {
  return steps.filter((step) => !step.hidden && !step.done && step.optional);
}

/** The id of the step the wizard should open. */
export function nextStepId(steps) {
  return pendingSteps(steps)[0]?.id ?? null;
}

/** True when nothing that blocks the application is left. */
export function isSetupComplete(steps) {
  return pendingSteps(steps).length === 0;
}

/**
 * Summarise this month's spending for the footer calculator.
 * @param {object|null} usageMonth contents of data/usage/<month>.json
 * @param {object|null} settings contents of data/settings.json
 */
export function usageSummary(usageMonth, settings) {
  const totals = usageMonth?.totals ?? {};
  const budget = settings?.values?.budget ?? {};
  const limitUsd = Number(budget.monthly_usd ?? 5);
  const warnRatio = Number(budget.warn_ratio ?? 0.8);
  const costUsd = Number(totals.cost_usd ?? 0);

  let status = "ok";
  if (limitUsd > 0 && costUsd >= limitUsd) {
    status = "blocked";
  } else if (limitUsd > 0 && costUsd >= limitUsd * warnRatio) {
    status = "warn";
  }

  return {
    digests: Number(totals.digests ?? 0),
    // Questions are billed like digests but are not digests; the backend counts them
    // separately so the dashboard does not claim more digests than exist.
    questions: Number(totals.questions ?? 0),
    tokensIn: Number(totals.tokens_in ?? 0),
    tokensOut: Number(totals.tokens_out ?? 0),
    cacheHitTokens: Number(totals.cache_hit_tokens ?? 0),
    costUsd,
    limitUsd,
    ratio: limitUsd > 0 ? Math.min(costUsd / limitUsd, 1) : 1,
    status,
  };
}

/**
 * True when a state file was written at or after ``sinceMs``.
 *
 * Polls must ignore anything older than the action that started them: a previous
 * attempt's failure is still on disk when a new one begins, and reporting it would show
 * the user an error for a request that has not finished yet.
 *
 * @param {object|null} state contents of a run or login state file
 * @param {number} sinceMs epoch milliseconds captured before the action started
 */
export function isNewerThan(state, sinceMs) {
  const stamp = state?.updated_at ? Date.parse(state.updated_at) : Number.NaN;
  return Number.isFinite(stamp) && stamp >= sinceMs;
}

/** Format a number with thin spaces, for the footer. */
export function formatTokens(value) {
  return new Intl.NumberFormat("ru-RU").format(Number(value ?? 0));
}

/** Format a USD amount with four decimals, the scale a digest actually costs. */
export function formatUsd(value) {
  return `$${Number(value ?? 0).toFixed(4)}`;
}

/**
 * Turn a chat from the account directory into channel form values.
 *
 * Picking a chat beats typing a numeric id from memory, and the directory already knows
 * the title, the username and whether the chat is a forum.
 *
 * @param {object} dialog one item of data/login/dialogs.json
 */
export function dialogToChannel(dialog) {
  const type = dialog?.type ?? "channel";
  return {
    title: String(dialog?.title ?? ""),
    // Telegram ids exceed 2^53, so they travel as strings.
    tg_id: dialog?.id === undefined || dialog?.id === null ? "" : String(dialog.id),
    username: dialog?.username ?? "",
    type,
    has_topics: type === "forum" || Boolean(dialog?.is_forum),
  };
}

/**
 * The chats worth offering as digest sources: no private conversations, no bots, no
 * Telegram's own service chat.
 */
export function selectableDialogs(dialogs) {
  return (dialogs ?? []).filter(
    (item) =>
      item &&
      item.type !== "user" &&
      Number(item.id) !== 777000 && // Telegram's service account
      String(item.title ?? "").trim() !== "",
  );
}

/**
 * Format an ISO timestamp for a Russian reader, or a dash when absent.
 *
 * Always UTC, never the browser's zone. Every timestamp the app shows is compared against
 * something the backend wrote in UTC — the period inside the digest, the tariff clock, the
 * run records — and rendering the list in local time made the same digest read "11:40" in
 * the list and "08:40 UTC" once opened.
 */
export function formatMoment(value) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

/** Format just the date part, for the statistics table. Days are UTC days too. */
export function formatDate(value) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

/**
 * Group a month's usage records by UTC day, newest first.
 *
 * The stored file keeps a flat list plus month totals; the statistics screen needs the
 * per-day cut, and the browser is the right place to compute it.
 *
 * @param {object|null} usageMonth contents of data/usage/<YYYY-MM>.json
 * @returns {Array<{date: string, digests: number, tokensIn: number, tokensOut: number,
 *                  cacheHitTokens: number, costUsd: number}>}
 */
export function usageByDay(usageMonth) {
  const buckets = new Map();
  for (const item of usageMonth?.items ?? []) {
    const day = String(item.created_at ?? "").slice(0, 10);
    if (!day) {
      continue;
    }
    const bucket = buckets.get(day) ?? {
      date: day,
      digests: 0,
      questions: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheHitTokens: 0,
      costUsd: 0,
    };
    if (String(item.digest_id ?? "").startsWith("ask:")) {
      bucket.questions += 1;
    } else {
      bucket.digests += 1;
    }
    bucket.tokensIn += Number(item.tokens_in ?? 0);
    bucket.tokensOut += Number(item.tokens_out ?? 0);
    bucket.cacheHitTokens += Number(item.cache_hit_tokens ?? 0);
    bucket.costUsd += Number(item.cost_usd ?? 0);
    buckets.set(day, bucket);
  }
  return [...buckets.values()].sort((left, right) => right.date.localeCompare(left.date));
}

/**
 * Reduce a digest to its key points, for the "краткий" view.
 *
 * @param {Array<{title: string, bullets: string[]}>} topics
 * @param {number} [perTopic] how many bullets to keep
 */
export function briefTopics(topics, perTopic = 2) {
  return (topics ?? []).map((topic) => ({
    title: topic.title,
    bullets: (topic.bullets ?? []).slice(0, perTopic),
  }));
}

/**
 * Build the suggested file name for a downloaded digest.
 *
 * The style goes into the name when there is one: a digest holds several versions of the
 * same period, and three files called the same thing in one downloads folder would be a
 * puzzle.
 */
export function digestFileName(digest, style = "") {
  const clean = (value) =>
    String(value ?? "")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  const safeChannel = clean(digest?.channel_title);
  const safeStyle = clean(style);
  return [digest?.id ?? "digest", safeChannel || "digest", safeStyle || null]
    .filter(Boolean)
    .join("-")
    .concat(".md");
}
