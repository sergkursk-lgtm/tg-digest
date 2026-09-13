/**
 * Minimal GitHub API client for the browser.
 *
 * The app has no server, so the browser talks to GitHub directly: `api.github.com`
 * sends `Access-Control-Allow-Origin: *`, which makes this possible from a static page.
 * The client is deliberately narrow — only the calls this project actually makes — so
 * the whole surface can be covered by tests.
 *
 * Errors are translated into Russian sentences a user can act on, because "HTTP 403"
 * on its own tells nobody which token permission is missing.
 */

import { fromBase64, toBase64, utf8Decode, utf8Encode } from "./bytes.js";
import { sealBox } from "./seal.js";

export const API_ROOT = "https://api.github.com";

/** Branch of the private repository that holds all application data. */
export const DATA_BRANCH = "data";

const API_VERSION = "2022-11-28";

/** Raised for any non-success response, with the status kept for branching. */
export class GitHubError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.body = body;
  }
}

/** Turn an HTTP status plus GitHub's body into something worth showing. */
function describe(status, body, context) {
  const detail = typeof body === "object" && body ? body.message : String(body ?? "");
  if (status === 401) {
    return "GitHub отклонил токен (401). Проверьте, что токен не истёк и скопирован целиком.";
  }
  if (status === 403) {
    return (
      `не хватает прав (403) для «${context}». Нужны права Actions: read/write, ` +
      "Contents: read/write, Secrets: read/write и Metadata: read."
    );
  }
  if (status === 404) {
    return `не найдено (404): «${context}». Проверьте имя репозитория и доступ токена к нему.`;
  }
  if (status === 409 || status === 422) {
    return `конфликт версий (${status}) при «${context}»: файл изменился между чтением и записью.`;
  }
  return `«${context}»: HTTP ${status}${detail ? ` — ${detail}` : ""}`;
}

/**
 * Create a client bound to one repository.
 *
 * @param {object} options
 * @param {string} options.token GitHub token with Contents, Actions and Secrets write
 * @param {string} options.owner repository owner
 * @param {string} options.repo repository name
 * @param {object} options.nacl the vendored tweetnacl namespace
 * @param {Function} [options.fetchImpl] injected for tests
 * @param {string} [options.apiRoot] injected for tests
 */
export function createGitHub({
  token,
  owner,
  repo,
  nacl,
  fetchImpl = fetch,
  apiRoot = API_ROOT,
}) {
  const repoBase = `${apiRoot}/repos/${owner}/${repo}`;
  const repoName = `${owner}/${repo}`;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
  };

  /** Send a request and convert failures into readable errors. */
  async function request(url, init = {}, { context = url, allow404 = false } = {}) {
    let response;
    try {
      response = await fetchImpl(url, { headers, ...init });
    } catch (error) {
      throw new GitHubError(`нет связи с GitHub: ${error.message}`, 0, null);
    }

    if (allow404 && response.status === 404) {
      return null;
    }
    if (!response.ok) {
      let body = null;
      try {
        body = await response.json();
      } catch (error) {
        body = null;
      }
      throw new GitHubError(describe(response.status, body, context), response.status, body);
    }

    // Several endpoints (secret writes, workflow dispatch) answer 201/204 with an empty
    // body, so parsing unconditionally would throw on success.
    const text = await response.text();
    if (!text.trim()) {
      return {};
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      return {};
    }
  }

  const contentsUrl = (path) => `${repoBase}/contents/${path}`;

  return {
    owner,
    repo,
    repoName,
    token,

    /** Return the authenticated login, proving the token works at all. */
    async whoami() {
      const body = await request(`${apiRoot}/user`, {}, { context: "проверка токена" });
      return { login: body.login, name: body.name ?? null };
    },

    /** Check that the token can actually see the target repository. */
    async assertRepositoryAccess() {
      const body = await request(repoBase, {}, { context: `доступ к ${repoName}` });
      return {
        fullName: body.full_name,
        private: Boolean(body.private),
        defaultBranch: body.default_branch ?? "main",
        canPush: Boolean(body.permissions?.push),
      };
    },

    /** Names of the repository's secrets. Values are never returned by GitHub. */
    async listSecretNames() {
      const body = await request(
        `${repoBase}/actions/secrets`,
        {},
        { context: "список секретов" },
      );
      return (body.secrets ?? []).map((entry) => entry.name);
    },

    /**
     * Write a secret, sealing it to the repository public key.
     *
     * Sealing is not optional: the endpoint rejects a plaintext or wrongly encrypted
     * value, and the sealed box must be byte-for-byte libsodium's construction.
     */
    async putSecret(name, value) {
      const key = await request(
        `${repoBase}/actions/secrets/public-key`,
        {},
        { context: "публичный ключ репозитория" },
      );
      const encrypted = sealBox(nacl, value, key.key);
      await request(
        `${repoBase}/actions/secrets/${name}`,
        {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ encrypted_value: encrypted, key_id: key.key_id }),
        },
        { context: `запись секрета ${name}` },
      );
      return true;
    },

    /** Delete a secret; deleting a missing one is not an error. */
    async deleteSecret(name) {
      await request(
        `${repoBase}/actions/secrets/${name}`,
        { method: "DELETE" },
        { context: `удаление секрета ${name}`, allow404: true },
      );
      return true;
    },

    /**
     * Read a JSON file from the data branch.
     * @returns {Promise<{data: object, sha: string}|null>} null when it does not exist
     */
    async readJson(path) {
      const body = await request(
        `${contentsUrl(path)}?ref=${DATA_BRANCH}`,
        {},
        { context: `чтение ${path}`, allow404: true },
      );
      if (body === null) {
        return null;
      }
      const raw = fromBase64(String(body.content ?? "").replace(/\s+/g, ""));
      return { data: JSON.parse(utf8Decode(raw)), sha: body.sha };
    },

    /**
     * Create or replace a JSON file in the data branch.
     * @returns {Promise<string>} the new commit sha
     */
    async writeJson(path, payload, message, sha = null) {
      const body = {
        message,
        content: toBase64(utf8Encode(JSON.stringify(payload, null, 2) + "\n")),
        branch: DATA_BRANCH,
      };
      if (sha) {
        body.sha = sha;
      }
      const response = await request(
        contentsUrl(path),
        {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        { context: `запись ${path}` },
      );
      return response.content?.sha ?? "";
    },

    /** Delete a file from the data branch, ignoring a missing one. */
    async deleteFile(path, message, sha) {
      await request(
        contentsUrl(path),
        {
          method: "DELETE",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ message, sha, branch: DATA_BRANCH }),
        },
        { context: `удаление ${path}`, allow404: true },
      );
      return true;
    },

    /** Start a workflow. Inputs are recorded in the run, so never pass a credential. */
    async dispatch(workflowFile, inputs = {}, ref = "main") {
      await request(
        `${repoBase}/actions/workflows/${workflowFile}/dispatches`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ ref, inputs }),
        },
        { context: `запуск ${workflowFile}` },
      );
      return true;
    },

    /** The most recent run of a workflow, or null when it never ran. */
    async latestRun(workflowFile) {
      const body = await request(
        `${repoBase}/actions/workflows/${workflowFile}/runs?per_page=1`,
        {},
        { context: `статус ${workflowFile}` },
      );
      const run = (body.workflow_runs ?? [])[0];
      if (!run) {
        return null;
      }
      return {
        id: run.id,
        status: run.status,
        conclusion: run.conclusion,
        createdAt: run.created_at,
        url: run.html_url,
        event: run.event,
      };
    },

    /** Read a file from any branch, used for the workflow-run status file. */
    async readJsonOnBranch(path, branch) {
      const body = await request(
        `${contentsUrl(path)}?ref=${branch}`,
        {},
        { context: `чтение ${path}`, allow404: true },
      );
      if (body === null) {
        return null;
      }
      const raw = fromBase64(String(body.content ?? "").replace(/\s+/g, ""));
      return { data: JSON.parse(utf8Decode(raw)), sha: body.sha };
    },
  };
}
