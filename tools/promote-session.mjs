/**
 * Move the Telegram session from the data branch into GitHub Secrets.
 *
 * The wizard does this in the browser; this is the same operation for the terminal, so the
 * manual setup path can end in the same state: the session in Secrets and nothing but
 * non-secret state in the branch.
 *
 *     GITHUB_TOKEN=... node tools/promote-session.mjs
 *
 * Exit code 0 means the secret was written and the branch copy cleared; 1 means the
 * session is still in the branch.
 */

import { createRequire } from "node:module";

import { createGitHub } from "../frontend/assets/api.js";

const require = createRequire(import.meta.url);
const nacl = require("../frontend/vendor/tweetnacl.js");

const [owner, repo] = (process.env.REPO ?? "sergkursk-lgtm/tg-digest-core").split("/");
const token = process.env.GITHUB_TOKEN;
const KEEP_COPY = process.argv.includes("--keep-copy");

if (!token) {
  console.error("GITHUB_TOKEN is required");
  process.exit(2);
}

const client = createGitHub({ owner, repo, token, nacl });
const STATE_PATH = "data/login/state.json";

const stored = await client.readJson(STATE_PATH);
const state = stored?.data;
const session = state?.session;

if (!state) {
  console.error("no login state in the branch: nothing to promote");
  process.exit(2);
}
if (!session) {
  console.log("the branch holds no session — it is already only in Secrets.");
  process.exit(0);
}

console.log(`session found: ${session.length} characters, account ${state.user_id ?? "unknown"}`);
await client.putSecret("TG_STRING_SESSION", session);
console.log("TG_STRING_SESSION written to GitHub Secrets");

if (KEEP_COPY) {
  console.log("--keep-copy: leaving the branch copy in place");
  process.exit(0);
}

await client.writeJson(
  STATE_PATH,
  { ...state, session: null, updated_at: new Date().toISOString() },
  "chore(login): move session to Secrets",
  stored.sha,
);
console.log("branch copy cleared");

const names = await client.listSecretNames();
console.log(`secrets now: ${names.join(", ")}`);
