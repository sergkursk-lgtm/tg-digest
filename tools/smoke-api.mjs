/**
 * Exercise the UI's own GitHub client against the real repository.
 *
 * The unit tests use a fake API; this runs the same code paths the browser will run —
 * reading every file the dashboard reads, listing secrets, and optionally dispatching a
 * digest — so a wrong endpoint or a wrong media type is caught before it is a blank page.
 *
 * Manual check, never part of `node --test`:
 *
 *     GITHUB_TOKEN=... node tools/smoke-api.mjs [--dispatch]
 *
 * Exit code 0 means the UI can talk to the repository; 1 means something in the client is
 * wrong.
 */

import { createRequire } from "node:module";

import { createGitHub } from "../frontend/assets/api.js";
import { PATHS, loadSnapshot, setupSteps, usageSummary } from "../frontend/assets/state.js";

const require = createRequire(import.meta.url);
const nacl = require("../frontend/vendor/tweetnacl.js");

const [owner, repo] = (process.env.REPO ?? "sergkursk-lgtm/tg-digest-core").split("/");
const token = process.env.GITHUB_TOKEN;
const dispatch = process.argv.includes("--dispatch");

if (!token) {
  console.error("GITHUB_TOKEN is required");
  process.exit(2);
}

const client = createGitHub({ owner, repo, token, nacl });
let failures = 0;

/** Report one check. */
function report(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    failures += 1;
  }
}

const who = await client.whoami();
report("whoami", Boolean(who.login), who.login);

const access = await client.assertRepositoryAccess();
report("repository access", access.fullName === `${owner}/${repo}`, `${access.fullName}, push=${access.canPush}`);

const secretNames = await client.listSecretNames();
report("list secrets", Array.isArray(secretNames), secretNames.join(", ") || "none");

const snapshot = await loadSnapshot(client);
console.log(
  `snapshot: ${snapshot.channels.length} channel(s), ${snapshot.digests.length} digest(s), ` +
    `usage month ${snapshot.month}`,
);

// Read the files directly as well: an empty collection is a legitimate answer, and
// "the file exists but is empty" must not be confused with "the read failed".
for (const path of [
  PATHS.settings,
  PATHS.channels,
  PATHS.presets,
  PATHS.templates,
  PATHS.digestIndex,
  PATHS.setupRun,
]) {
  const stored = await client.readJson(path);
  report(`read ${path}`, stored !== null && typeof stored.data === "object");
}

// Files that may legitimately not exist yet: the read must return null, not throw.
for (const path of [PATHS.loginRequest, `data/usage/1999-01.json`, "data/login/state.json"]) {
  const missing = await client.readJson(path);
  report(`missing file returns null: ${path}`, missing === null);
}

const steps = setupSteps(snapshot, secretNames);
console.log("\nsetup checklist from the UI's point of view:");
for (const step of steps.filter((entry) => !entry.hidden)) {
  console.log(`  ${step.done ? "[x]" : "[ ]"} ${step.id} — ${step.title}`);
}

const summary = usageSummary(snapshot.usage, snapshot.settings);
console.log(
  `\nfooter: tokens in/out ${summary.tokensIn}/${summary.tokensOut}, ` +
    `${summary.costUsd.toFixed(4)} of ${summary.limitUsd.toFixed(2)} USD, ${summary.status}`,
);

const run = await client.latestRun("digest.yml");
report("latest digest run", run === null || Boolean(run.id), run ? `${run.id} ${run.conclusion}` : "never ran");

if (dispatch) {
  await client.dispatch("digest.yml", { channel_ids: "", period_hours: "", dry_run: "true" });
  report("dispatch digest.yml (dry run)", true);
  console.log("  the run appears in Actions within a few seconds");
}

console.log(`\n${failures === 0 ? "OK: the UI client works against the real repository." : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
