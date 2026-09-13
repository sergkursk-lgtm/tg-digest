/**
 * Tests for the GitHub API client.
 *
 * The fake API is deliberately faithful about the two details that are easy to get
 * wrong: secrets must arrive sealed to the repository key (the fake tries to open the
 * sealed value with the matching private key), and file writes must carry the current
 * sha.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { API_ROOT, GitHubError, createGitHub } from "../frontend/assets/api.js";
import { openSealedBox } from "../frontend/assets/seal.js";
import { toBase64 } from "../frontend/assets/bytes.js";

const require = createRequire(import.meta.url);
const nacl = require("../frontend/vendor/tweetnacl.js");

const OWNER = "sergkursk-lgtm";
const REPO = "tg-digest-core";
const REPO_BASE = `${API_ROOT}/repos/${OWNER}/${REPO}`;

/** An in-memory GitHub good enough for this client's calls. */
function createFakeGitHub(options = {}) {
  const keyPair = nacl.box.keyPair();
  const state = {
    files: new Map(),
    secrets: new Map(),
    dispatches: [],
    calls: [],
    shaCounter: 0,
    conflictNextWrites: 0,
    secretPlaintext: new Map(),
    keyPair,
    permissionDenied: options.permissionDenied ?? null,
  };

  function json(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function nextSha() {
    state.shaCounter += 1;
    return state.shaCounter.toString(16).padStart(40, "0");
  }

  async function fetchImpl(url, init = {}) {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    state.calls.push({ url, method, body, cache: init.cache });

    // Reads carry a cache-busting parameter; route on the path only.
    const path = url.split("?")[0];

    if (state.permissionDenied && url.includes(state.permissionDenied)) {
      return json({ message: "Resource not accessible by personal access token" }, 403);
    }

    if (path === `${API_ROOT}/user`) {
      return json({ login: "tester", name: "Test User" });
    }
    if (path === REPO_BASE) {
      return json({
        full_name: `${OWNER}/${REPO}`,
        private: true,
        default_branch: "main",
        permissions: { push: true },
      });
    }
    if (path === `${REPO_BASE}/actions/secrets/public-key`) {
      return json({ key_id: "key-1", key: toBase64(keyPair.publicKey) });
    }
    if (path === `${REPO_BASE}/actions/secrets` && method === "GET") {
      return json({ secrets: [...state.secrets.keys()].map((name) => ({ name })) });
    }
    if (path.startsWith(`${REPO_BASE}/actions/secrets/`)) {
      const name = decodeURIComponent(path.slice(`${REPO_BASE}/actions/secrets/`.length));
      if (method === "PUT") {
        const opened = openSealedBox(
          nacl,
          body.encrypted_value,
          keyPair.publicKey,
          keyPair.secretKey,
        );
        state.secrets.set(name, { keyId: body.key_id });
        state.secretPlaintext.set(name, opened);
        return new Response(null, { status: 201 });
      }
      if (method === "DELETE") {
        if (!state.secrets.has(name)) {
          return json({ message: "Not Found" }, 404);
        }
        state.secrets.delete(name);
        state.secretPlaintext.delete(name);
        return new Response(null, { status: 204 });
      }
    }

    const contentsMatch = url.match(/\/contents\/([^?]+)(\?ref=([^&]+))?/);
    if (contentsMatch) {
      const path = decodeURIComponent(contentsMatch[1]);
      const ref = contentsMatch[3];
      if (method === "GET") {
        const file = state.files.get(path);
        if (!file) {
          return json({ message: "Not Found" }, 404);
        }
        return json({ sha: file.sha, content: toBase64(new TextEncoder().encode(file.content)) });
      }
      if (method === "PUT") {
        if (state.conflictNextWrites > 0) {
          state.conflictNextWrites -= 1;
          return json({ message: "sha mismatch" }, 409);
        }
        if (body.branch !== "data") {
          return json({ message: "wrong branch" }, 422);
        }
        const existing = state.files.get(path);
        if (existing && body.sha && body.sha !== existing.sha) {
          return json({ message: "sha mismatch" }, 409);
        }
        const content = new TextDecoder().decode(
          Uint8Array.from(atob(body.content), (character) => character.charCodeAt(0)),
        );
        const sha = nextSha();
        state.files.set(path, { content, sha, ref: body.branch });
        return json({ content: { sha } });
      }
      if (method === "DELETE") {
        if (!state.files.has(path)) {
          return json({ message: "Not Found" }, 404);
        }
        state.files.delete(path);
        return json({ commit: { sha: nextSha() } });
      }
    }

    if (path.includes("/actions/workflows/") && path.endsWith("/dispatches")) {
      state.dispatches.push(body);
      return new Response(null, { status: 204 });
    }
    if (path.includes("/actions/workflows/") && path.includes("/runs")) {
      return json({
        workflow_runs: state.dispatches.length
          ? [
              {
                id: 42,
                status: "completed",
                conclusion: "success",
                created_at: "2026-09-13T12:00:00Z",
                html_url: "https://example.invalid/run/42",
                event: "workflow_dispatch",
              },
            ]
          : [],
      });
    }

    throw new Error(`unexpected request: ${method} ${url}`);
  }

  return { state, fetchImpl };
}

function clientFor(fake) {
  return createGitHub({
    token: "pat-test",
    owner: OWNER,
    repo: REPO,
    nacl,
    fetchImpl: fake.fetchImpl,
  });
}

// -- identity and access ------------------------------------------------------

test("whoami returns the authenticated login", async () => {
  const fake = createFakeGitHub();
  assert.deepEqual(await clientFor(fake).whoami(), { login: "tester", name: "Test User" });
});

test("repository access reports the default branch and write permission", async () => {
  const fake = createFakeGitHub();
  const access = await clientFor(fake).assertRepositoryAccess();
  assert.equal(access.fullName, `${OWNER}/${REPO}`);
  assert.equal(access.private, true);
  assert.equal(access.canPush, true);
});

test("a rejected token explains what to check", async () => {
  const fake = createFakeGitHub();
  const failing = createGitHub({
    token: "bad",
    owner: OWNER,
    repo: REPO,
    nacl,
    fetchImpl: async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
  });
  await assert.rejects(() => failing.whoami(), (error) => {
    assert.ok(error instanceof GitHubError);
    assert.equal(error.status, 401);
    assert.match(error.message, /отклонил токен/);
    return true;
  });
  assert.ok(fake.state.calls.length === 0);
});

test("a missing permission names the permission that is needed", async () => {
  const fake = createFakeGitHub({ permissionDenied: "/actions/secrets" });
  await assert.rejects(() => clientFor(fake).listSecretNames(), (error) => {
    assert.equal(error.status, 403);
    assert.match(error.message, /Secrets: read\/write/);
    return true;
  });
});

// -- secrets ------------------------------------------------------------------

test("a secret is written sealed and decrypts to the original value", async () => {
  const fake = createFakeGitHub();
  const client = clientFor(fake);
  await client.putSecret("TG_API_ID", "38843417");

  // The fake opened the sealed value with the repository private key, which is exactly
  // what GitHub does; the plaintext proves the sealing construction is right.
  assert.equal(fake.state.secretPlaintext.get("TG_API_ID"), "38843417");
  assert.equal(fake.state.secrets.get("TG_API_ID").keyId, "key-1");
});

test("the secret value never appears in the request body", async () => {
  const fake = createFakeGitHub();
  await clientFor(fake).putSecret("DEEPSEEK_API_KEY", "sk-super-secret");

  const put = fake.state.calls.find((call) => call.method === "PUT" && call.url.includes("/secrets/"));
  assert.ok(put);
  assert.ok(!JSON.stringify(put.body).includes("sk-super-secret"));
  assert.equal(put.url, `${REPO_BASE}/actions/secrets/DEEPSEEK_API_KEY`);
});

test("secrets are listed by name only", async () => {
  const fake = createFakeGitHub();
  const client = clientFor(fake);
  await client.putSecret("TG_PHONE", "+79001234567");
  assert.deepEqual(await client.listSecretNames(), ["TG_PHONE"]);
});

test("deleting a secret that does not exist is not an error", async () => {
  const fake = createFakeGitHub();
  assert.equal(await clientFor(fake).deleteSecret("NOPE"), true);
});

test("deleting an existing secret removes it", async () => {
  const fake = createFakeGitHub();
  const client = clientFor(fake);
  await client.putSecret("TMP", "value");
  await client.deleteSecret("TMP");
  assert.deepEqual(await client.listSecretNames(), []);
});

// -- data branch files --------------------------------------------------------

test("reading a missing file returns null instead of throwing", async () => {
  const fake = createFakeGitHub();
  assert.equal(await clientFor(fake).readJson("data/settings.json"), null);
});

test("a file round-trips through the data branch", async () => {
  const fake = createFakeGitHub();
  const client = clientFor(fake);
  await client.writeJson("data/settings.json", { schema: 1, values: { budget: 5 } }, "msg");

  const stored = await client.readJson("data/settings.json");
  assert.equal(stored.data.values.budget, 5);
  assert.equal(stored.sha.length, 40);
  assert.equal(fake.state.files.get("data/settings.json").ref, "data");
});

test("writes target the data branch, never the default branch", async () => {
  const fake = createFakeGitHub();
  await clientFor(fake).writeJson("data/x.json", {}, "msg");
  const put = fake.state.calls.find((call) => call.method === "PUT");
  assert.equal(put.body.branch, "data");
});

test("an update sends the sha it read", async () => {
  const fake = createFakeGitHub();
  const client = clientFor(fake);
  await client.writeJson("data/x.json", { a: 1 }, "first");
  const sha = fake.state.files.get("data/x.json").sha;

  await client.writeJson("data/x.json", { a: 2 }, "second", sha);
  const puts = fake.state.calls.filter((call) => call.method === "PUT");
  assert.equal(puts[1].body.sha, sha);
  assert.equal((await client.readJson("data/x.json")).data.a, 2);
});

test("a stale sha is recovered from, not reported", async () => {
  // The runner writes the same files, so a sha read a moment ago can be stale; the user
  // must not see "конфликт версий" for something they cannot control.
  const fake = createFakeGitHub();
  const client = clientFor(fake);
  await client.writeJson("data/x.json", { a: 1 }, "first");
  await client.writeJson("data/x.json", { a: 2 }, "second", "0".repeat(40));
  assert.equal((await client.readJson("data/x.json")).data.a, 2);
});

test("a lost write race is retried with the fresh sha", async () => {
  const fake = createFakeGitHub();
  const client = clientFor(fake);
  await client.writeJson("data/x.json", { a: 1 }, "first");
  fake.state.conflictNextWrites = 1;

  await client.writeJson("data/x.json", { a: 2 }, "second", "0".repeat(40));
  const puts = fake.state.calls.filter((call) => call.method === "PUT");
  assert.equal(puts.length, 3); // create, rejected, retried
  assert.equal((await client.readJson("data/x.json")).data.a, 2);
});

test("persistent conflicts are reported clearly", async () => {
  const fake = createFakeGitHub();
  fake.state.conflictNextWrites = 9;
  await assert.rejects(
    () => clientFor(fake).writeJson("data/x.json", { a: 1 }, "msg", "0".repeat(40)),
    /конфликт версий|не удалось записать/,
  );
});

test("json is stored indented so diffs stay readable", async () => {
  const fake = createFakeGitHub();
  await clientFor(fake).writeJson("data/x.json", { b: 1, a: 2 }, "msg");
  const stored = fake.state.files.get("data/x.json").content;
  assert.match(stored, /\n {2}"b": 1/);
  assert.ok(stored.endsWith("\n"));
});

test("deleting a file from the data branch works and tolerates absence", async () => {
  const fake = createFakeGitHub();
  const client = clientFor(fake);
  const sha = await client.writeJson("data/tmp.json", {}, "msg");
  await client.deleteFile("data/tmp.json", "remove", sha);
  assert.equal(await client.readJson("data/tmp.json"), null);
  assert.equal(await client.deleteFile("data/tmp.json", "remove", sha), true);
});

// -- workflows ----------------------------------------------------------------

test("dispatching a workflow posts the inputs to the right endpoint", async () => {
  const fake = createFakeGitHub();
  await clientFor(fake).dispatch("telegram-login.yml", { step: "send-code" });

  assert.equal(fake.state.dispatches.length, 1);
  assert.deepEqual(fake.state.dispatches[0], {
    ref: "main",
    inputs: { step: "send-code" },
  });
});

test("the latest run is summarised for the UI", async () => {
  const fake = createFakeGitHub();
  const client = clientFor(fake);
  assert.equal(await client.latestRun("digest.yml"), null);

  await client.dispatch("digest.yml", {});
  const run = await client.latestRun("digest.yml");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  assert.equal(run.id, 42);
});

test("a file can be read from an explicit branch", async () => {
  const fake = createFakeGitHub();
  fake.state.files.set("data/x.json", {
    content: '{"ok":true}',
    sha: "a".repeat(40),
    ref: "other",
  });
  const stored = await clientFor(fake).readJsonOnBranch("data/x.json", "data");
  assert.equal(stored.data.ok, true);
});

// -- cache behaviour ----------------------------------------------------------

test("reads ask the browser not to cache", async () => {
  // GitHub serves Contents reads with `Cache-Control: private, max-age=60`. Without this
  // the wizard's poll kept seeing a stale body — observed while watching a login step.
  const fake = createFakeGitHub();
  const seen = [];
  const client = createGitHub({
    token: "pat-test",
    owner: OWNER,
    repo: REPO,
    nacl,
    fetchImpl: async (url, init) => {
      seen.push(init?.cache);
      return fake.fetchImpl(url, init);
    },
  });

  await client.readJson("data/settings.json");
  await client.listSecretNames();
  await client.latestRun("digest.yml");
  assert.ok(seen.length >= 3);
  assert.ok(
    seen.every((value) => value === "no-store"),
    `expected no-store everywhere, saw ${JSON.stringify(seen)}`,
  );
});

test("consecutive reads use different URLs so no cache layer can serve a stale body", async () => {
  const fake = createFakeGitHub();
  const client = clientFor(fake);
  await client.readJson("data/settings.json");
  await new Promise((resolve) => setTimeout(resolve, 2));
  await client.readJson("data/settings.json");

  const reads = fake.state.calls.filter((call) => call.method === "GET" && call.url.includes("/contents/"));
  assert.equal(reads.length, 2);
  assert.notEqual(reads[0].url, reads[1].url);
  assert.match(reads[0].url, /[?&]_=\d+/);
});

test("writes are not affected by the cache-busting parameter", async () => {
  const fake = createFakeGitHub();
  await clientFor(fake).writeJson("data/x.json", { a: 1 }, "msg");
  const put = fake.state.calls.find((call) => call.method === "PUT");
  assert.ok(!put.url.includes("_="));
  assert.equal(put.body.branch, "data");
});
