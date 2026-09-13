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
  channels: "data/channels.json",
  presets: "data/presets.json",
  templates: "data/templates.json",
  digestIndex: "data/digests/index.json",
  setupRun: "data/runs/setup-check.json",
};

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
  const [settings, login, channels, presets, templates, index, usage, setupRun] =
    await Promise.all([
      readOrNull(client, PATHS.settings),
      readOrNull(client, PATHS.loginState),
      readOrNull(client, PATHS.channels),
      readOrNull(client, PATHS.presets),
      readOrNull(client, PATHS.templates),
      readOrNull(client, PATHS.digestIndex),
      readOrNull(client, `data/usage/${month}.json`),
      readOrNull(client, PATHS.setupRun),
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
 * Work out which setup steps are still outstanding.
 *
 * Credentials may come from GitHub Secrets or from the data branch, so both sources are
 * consulted; the branch is what the wizard writes before it can reach Secrets.
 *
 * @param {object} snapshot result of loadSnapshot
 * @param {string[]} secretNames names present in the repository
 * @returns {Array<{id: string, title: string, hint: string, done: boolean, hidden: boolean}>}
 */
export function setupSteps(snapshot, secretNames = []) {
  const login = snapshot?.login ?? {};
  const telegram = snapshot?.settings?.values?.telegram ?? {};
  const has = (name) => secretNames.includes(name);

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
      hint: "токен бота от @BotFather и ваш chat_id",
      done: botReady,
      hidden: false,
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

/** The visible, not-yet-finished steps. */
export function pendingSteps(steps) {
  return steps.filter((step) => !step.hidden && !step.done);
}

/** The id of the step the wizard should open. */
export function nextStepId(steps) {
  return pendingSteps(steps)[0]?.id ?? null;
}

/** True when every visible step is done. */
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

/** Format an ISO timestamp for a Russian reader, or a dash when absent. */
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
  }).format(date);
}

/** Format just the date part, for the statistics table. */
export function formatDate(value) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" }).format(date);
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
      tokensIn: 0,
      tokensOut: 0,
      cacheHitTokens: 0,
      costUsd: 0,
    };
    bucket.digests += 1;
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

/** Build the suggested file name for a downloaded digest. */
export function digestFileName(digest) {
  const safeChannel = String(digest?.channel_title ?? "digest")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${digest?.id ?? "digest"}-${safeChannel || "digest"}.md`;
}
