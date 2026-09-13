/**
 * Everything that talks to the private repository: secrets, the login workflow and
 * digest runs.
 *
 * The wizard, the settings screen and the "ask about a digest" box all need the same
 * three things — write a secret, drive a workflow to completion, verify a key — so they
 * share this module instead of each keeping its own copy of the polling loop.
 *
 * Two rules shape the file:
 *
 *   * a credential never travels through `workflow_dispatch` inputs, because those are
 *     recorded in the run and shown on the Actions page; the login code and the 2FA
 *     password go into `data/login/request.json`, which the workflow wipes as it consumes
 *     them;
 *   * a poll ignores any state file older than the action that started it. Without that,
 *     the previous attempt's failure is still on disk and gets reported as the result of
 *     a request that has not finished yet.
 */

import { DEFAULT_REPO, parseRepo } from "./local.js";
import { DEEPSEEK_SECRET, PATHS, isNewerThan } from "./state.js";

export const DEEPSEEK_API = "https://api.deepseek.com";
export const TELEGRAM_API = "https://api.telegram.org";
export const LOGIN_WORKFLOW = "telegram-login.yml";
export const SETUP_WORKFLOW = "setup.yml";
export const DIGEST_WORKFLOW = "digest.yml";
export const LIST_WORKFLOW = "telegram-list.yml";
export const ASK_WORKFLOW = "ask.yml";

/** GitHub workflow runs take a while to appear; this is the poll interval for "did it start". */
export const RUN_APPEAR_INTERVAL_MS = 4000;
export const RUN_APPEAR_TIMEOUT_MS = 120_000;

/**
 * Poll a probe until it returns a truthy value or the deadline passes.
 *
 * @param {() => Promise<any>} probe
 * @param {{intervalMs?: number, timeoutMs?: number}} [options]
 * @returns {Promise<any>} the first truthy result, or null on timeout
 */
export async function pollUntil(probe, { intervalMs = 3000, timeoutMs = 120_000 } = {}) {
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
 * Validate a DeepSeek key straight from the browser.
 *
 * The API echoes the `Origin` header, so this works from a page without a proxy. One
 * output token is enough to prove the key is live and to learn the model name.
 *
 * @param {string} key
 * @returns {Promise<{model: string, usage: object}>}
 */
export async function verifyDeepSeekKey(key) {
  const response = await fetch(`${DEEPSEEK_API}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-flash",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      thinking: { type: "disabled" },
    }),
  });
  if (response.status === 401) {
    throw new Error("DeepSeek отклонил ключ (401)");
  }
  if (response.status === 402) {
    throw new Error("на балансе DeepSeek нет средств (402)");
  }
  if (!response.ok) {
    throw new Error(`DeepSeek ответил HTTP ${response.status}`);
  }
  const body = await response.json();
  return { model: body.model, usage: body.usage ?? {} };
}

/**
 * Call a Telegram Bot API method from the browser.
 *
 * `api.telegram.org` sends `Access-Control-Allow-Origin: *`, so no proxy is needed.
 *
 * @param {string} method
 * @param {string} token
 * @param {object} [payload]
 */
export async function callBot(method, token, payload = {}) {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({ ok: false, description: "нечитаемый ответ" }));
  if (!body.ok) {
    throw new Error(body.description ?? `HTTP ${response.status}`);
  }
  return body.result;
}

/**
 * Find the chat ids that have written to the bot, so the user does not have to hunt for
 * their own numeric id.
 * @param {string} token
 * @returns {Promise<string[]>}
 */
export async function discoverChatIds(token) {
  const updates = await callBot("getUpdates", token, {});
  return [
    ...new Set(
      updates
        .map((update) => update.message?.chat?.id ?? update.my_chat_member?.chat?.id)
        .filter((id) => id !== undefined),
    ),
  ].map(String);
}

/** Merge bot delivery settings into data/settings.json without touching other values. */
export function mergeTelegramSettings(settings, telegram) {
  const base = settings ?? { schema: 1, values: {} };
  return {
    ...base,
    schema: base.schema ?? 1,
    values: {
      ...(base.values ?? {}),
      telegram: { ...(base.values?.telegram ?? {}), ...telegram },
    },
  };
}

/**
 * Build a channel record with the next free id.
 * @param {Array<object>} existing
 * @param {object} input
 * @param {string} nowIso
 */
export function buildChannel(existing, input, nowIso) {
  const nextId = existing.reduce((max, channel) => Math.max(max, Number(channel.id ?? 0)), 0) + 1;
  return {
    id: nextId,
    tg_id: String(input.tg_id ?? ""),
    title: input.title,
    username: input.username || null,
    type: input.type,
    has_topics: Boolean(input.has_topics),
    summary_style_id: input.summary_style_id ?? null,
    default_period_hours: Number(input.default_period_hours ?? 24),
    include_patterns: [],
    exclude_patterns: [],
    created_at: nowIso,
  };
}

/**
 * Drive `telegram-login.yml`.
 *
 * The interactive Telegram login is the one flow that cannot be reduced to a single
 * request: the user asks for a code, types it, and may then be asked for a 2FA password.
 * The bridge keeps the state file and the one-shot request file in sync with the workflow.
 *
 * @param {object} client the GitHub client from api.js
 */
export function createLoginBridge(client) {
  /** Persist the login state file, keeping the fields the backend needs. */
  async function saveState(patch) {
    // Read the file again rather than trusting the page snapshot: the workflow writes it
    // too, so a sha captured at render time is often already stale.
    const stored = await client.readJson(PATHS.loginState);
    const current = stored?.data ?? {};
    const payload = {
      schema: 1,
      updated_at: new Date().toISOString(),
      step: "idle",
      api_id: null,
      api_hash: "",
      phone: "",
      phone_code_hash: null,
      session: null,
      user_id: null,
      username: null,
      error: null,
      ...current,
      ...patch,
    };
    await client.writeJson(
      PATHS.loginState,
      payload,
      "chore(login): update state",
      stored?.sha ?? null,
    );
    return payload;
  }

  /** Write the one-shot request the login workflow consumes and then wipes. */
  async function saveRequest(patch) {
    const existing = await client.readJson(PATHS.loginRequest);
    const payload = {
      schema: 1,
      updated_at: new Date().toISOString(),
      step: "send_code",
      phone: "",
      code: "",
      password: "",
      ...patch,
    };
    await client.writeJson(
      PATHS.loginRequest,
      payload,
      `chore(login): request ${payload.step}`,
      existing?.sha,
    );
  }

  return {
    saveState,
    saveRequest,

    /** Try to write a secret; a permission failure is reported, never thrown. */
    async tryPutSecret(name, value) {
      try {
        await client.putSecret(name, value);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error.message, name };
      }
    },

    /**
     * Store the Telegram app credentials and ask Telegram for a login code.
     * @param {{apiId?: string, apiHash?: string, phone: string}} input
     */
    async requestCode({ apiId = "", apiHash = "", phone }) {
      const results = [await this.tryPutSecret("TG_PHONE", phone)];
      if (apiId) {
        results.push(await this.tryPutSecret("TG_API_ID", apiId));
      }
      if (apiHash) {
        results.push(await this.tryPutSecret("TG_API_HASH", apiHash));
      }
      const failed = results.find((result) => !result.ok) ?? null;

      const patch = {
        step: "idle",
        phone,
        session: null,
        user_id: null,
        username: null,
        error: null,
      };
      // Never blank out credentials that are already stored or in Secrets.
      if (apiId) {
        patch.api_id = Number(apiId);
      }
      if (apiHash) {
        patch.api_hash = apiHash;
      }
      await saveState(patch);

      const requestedAt = Date.now();
      await client.dispatch(LOGIN_WORKFLOW, { step: "send-code" });
      const state = await pollUntil(async () => {
        const data = (await client.readJson(PATHS.loginState))?.data;
        if (!isNewerThan(data, requestedAt)) {
          return null;
        }
        if (data.step === "failed") {
          throw new Error(data.error ?? "Telegram отказал");
        }
        return data.step === "code_sent" ? data : null;
      });

      if (!state) {
        throw new Error("код не отправился за две минуты — посмотрите Actions → telegram-login");
      }
      return { state, secretFailure: failed };
    },

    /**
     * Submit the login code (and the 2FA password when the account has one).
     * @param {{phone: string, code: string, password?: string}} input
     */
    async submitCode({ phone, code, password = "" }) {
      await saveRequest({ step: "sign_in", phone, code, password });
      const submittedAt = Date.now();
      await client.dispatch(LOGIN_WORKFLOW, { step: "sign-in" });

      const state = await pollUntil(async () => {
        const data = (await client.readJson(PATHS.loginState))?.data;
        if (!isNewerThan(data, submittedAt)) {
          return null;
        }
        if (data.step === "authorized") {
          return data;
        }
        // A wrong code leaves the state retryable but records the reason, so the same
        // code request can be used again instead of starting over.
        if (data.step === "failed" || data.error) {
          throw new Error(data.error ?? "вход не удался");
        }
        return null;
      });

      if (!state) {
        throw new Error("вход не завершился за две минуты — посмотрите Actions → telegram-login");
      }
      return state;
    },
  };
}

/**
 * A digest run, as reported by `data/runs/<id>.json`.
 * @typedef {object} RunRecord
 * @property {number|string} id
 * @property {"running"|"ok"|"failed"} status
 * @property {string} [error]
 * @property {Array<{name: string, status: string, detail?: string}>} [steps]
 */

/**
 * Dispatch a workflow and follow its run record to completion.
 *
 * The four stages the UI shows — read Telegram, summarise, store, deliver — come from the
 * `steps` array the workflow writes, so progress is real rather than a timed animation.
 *
 * @param {object} options
 * @param {object} options.client the GitHub client
 * @param {string} options.workflow
 * @param {object} [options.inputs]
 * @param {(record: RunRecord) => void} [options.onProgress] called on every poll
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.waitForRecord] false for workflows that write no run record —
 *        `telegram-list.yml` only writes the chat list, and waiting for a record that will
 *        never appear blocked the UI for the whole timeout
 * @param {(run: object) => void} [options.onRunStarted] called as soon as the run appears
 * @returns {Promise<{runId: number|string, record: RunRecord|null, started: boolean}>}
 */
export async function runWorkflow({
  client,
  workflow,
  inputs = {},
  onProgress,
  timeoutMs = 15 * 60_000,
  waitForRecord = true,
  onRunStarted,
  // Poll timings are injectable so the tests do not have to wait out real intervals.
  appearIntervalMs = RUN_APPEAR_INTERVAL_MS,
  appearTimeoutMs = RUN_APPEAR_TIMEOUT_MS,
  recordIntervalMs = 5000,
} = {}) {
  const before = await client.latestRun(workflow);
  await client.dispatch(workflow, inputs);

  const run = await pollUntil(
    async () => {
      const latest = await client.latestRun(workflow);
      return latest && latest.id !== before?.id ? latest : null;
    },
    { intervalMs: appearIntervalMs, timeoutMs: appearTimeoutMs },
  );
  if (!run) {
    return { runId: null, record: null, started: false };
  }

  onRunStarted?.(run);
  if (!waitForRecord) {
    // The caller follows its own artefact instead: the run record is not every workflow's
    // output, and polling for one that never arrives looks like a hang.
    return { runId: run.id, record: null, started: true };
  }

  const record = await pollUntil(
    async () => {
      const stored = await client.readJson(`data/runs/${run.id}.json`);
      const data = stored?.data;
      if (!data) {
        return null;
      }
      onProgress?.(data);
      return data.status !== "running" ? data : null;
    },
    { intervalMs: recordIntervalMs, timeoutMs },
  );

  return { runId: run.id, record, started: true };
}

/** Build a client for repository coordinates that are not saved yet. */
export function clientFor(factory, target, token) {
  const parsed = typeof target === "string" ? parseRepo(target) : target;
  return factory({ owner: parsed.owner, repo: parsed.repo, token });
}

export { DEFAULT_REPO, DEEPSEEK_SECRET, parseRepo };
