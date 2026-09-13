/**
 * Tests for the workflow runner.
 *
 * Two behaviours here were learned the hard way: a poll must ignore the *previous* run, and
 * not every workflow writes a run record. Waiting for one that never appears left the chat
 * list stuck on "Запускаю чтение…" for the full ten-minute timeout while the run itself had
 * finished in twenty seconds.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { runWorkflow } from "../frontend/assets/backend.js";

const TIMING = { appearIntervalMs: 1, appearTimeoutMs: 30, recordIntervalMs: 1 };

/**
 * A client that reports one run per dispatch and serves run records from a map.
 * @param {object} [options]
 * @param {Map<string, object>} [options.records] path -> record body
 * @param {boolean} [options.runAppears] whether the run shows up at all
 */
function fakeClient({ records = new Map(), runAppears = true } = {}) {
  const state = { dispatches: [], reads: [], runsSeen: 0 };
  let latest = null;
  return {
    state,
    async latestRun() {
      state.runsSeen += 1;
      return latest;
    },
    async dispatch(workflow, inputs) {
      state.dispatches.push({ workflow, inputs });
      // The run appears on the *next* poll, the way GitHub behaves.
      setTimeout(() => {
        if (runAppears) {
          latest = { id: 42, status: "completed", conclusion: "success" };
        }
      }, 1);
    },
    async readJson(path) {
      state.reads.push(path);
      const data = records.get(path);
      return data ? { data, sha: "a".repeat(40) } : { data: null, sha: null };
    },
  };
}

test("a run record is followed until it stops running", async () => {
  const records = new Map([
    ["data/runs/42.json", { status: "ok", steps: [{ name: "read:c1", status: "ok" }] }],
  ]);
  const client = fakeClient({ records });
  const seen = [];

  const result = await runWorkflow({
    client,
    workflow: "digest.yml",
    inputs: { channel_ids: "1" },
    onProgress: (record) => seen.push(record.status),
    ...TIMING,
  });

  assert.equal(result.started, true);
  assert.equal(result.runId, 42);
  assert.equal(result.record.status, "ok");
  assert.deepEqual(client.state.dispatches, [
    { workflow: "digest.yml", inputs: { channel_ids: "1" } },
  ]);
  // Progress is reported from the record the workflow writes, not from a timer.
  assert.deepEqual(seen, ["ok"]);
});

test("a workflow that writes no run record is not waited on", async () => {
  // This is the chat-list workflow: it writes data/login/dialogs.json and nothing else.
  const client = fakeClient();
  const started = [];

  const result = await runWorkflow({
    client,
    workflow: "telegram-list.yml",
    waitForRecord: false,
    onRunStarted: (run) => started.push(run.id),
    ...TIMING,
  });

  assert.equal(result.started, true);
  assert.equal(result.runId, 42);
  assert.equal(result.record, null);
  assert.deepEqual(started, [42]);
  assert.deepEqual(
    client.state.reads,
    [],
    "no run record may be polled when the caller asked for none",
  );
});

test("a run that never appears is reported rather than waited out", async () => {
  const client = fakeClient({ runAppears: false });
  const result = await runWorkflow({ client, workflow: "digest.yml", ...TIMING });
  assert.equal(result.started, false);
  assert.equal(result.runId, null);
  assert.equal(result.record, null);
});

test("a poll that times out returns no record but reports the run", async () => {
  const client = fakeClient();
  const result = await runWorkflow({
    client,
    workflow: "digest.yml",
    timeoutMs: 20,
    recordIntervalMs: 5,
    appearIntervalMs: 1,
    appearTimeoutMs: 30,
  });
  assert.equal(result.started, true);
  assert.equal(result.runId, 42);
  assert.equal(result.record, null);
});
