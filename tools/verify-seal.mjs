/**
 * Verify the browser-side sealed box against the live GitHub API.
 *
 * The crypto in `frontend/assets/seal.js` only has to satisfy one judge: GitHub's
 * secrets endpoint, which decrypts the value with libsodium and rejects anything that
 * does not match `crypto_box_seal` byte for byte. This script writes a throwaway
 * secret, confirms it exists, and deletes it again.
 *
 * Manual check, never part of `node --test` (it needs a token and touches the network):
 *
 *     GITHUB_TOKEN=... REPO=owner/name node tools/verify-seal.mjs
 *
 * Exit code 0 means the browser can write Secrets; 1 means it cannot.
 */

import { createRequire } from "node:module";

import { sealBox } from "../frontend/assets/seal.js";

const require = createRequire(import.meta.url);
const nacl = require("../frontend/vendor/tweetnacl.js");

const PROBE_NAME = "_SEAL_PROBE";
const PROBE_VALUE = "sealed-box-probe";

const repo = process.env.REPO ?? "sergkursk-lgtm/tg-digest-core";
const token = process.env.GITHUB_TOKEN;

if (!token) {
  console.error("GITHUB_TOKEN is required");
  process.exit(2);
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

/** Call the GitHub API and fail loudly on a transport error. */
async function api(path, init = {}) {
  return fetch(`https://api.github.com${path}`, { headers, ...init });
}

/** List the repository's secret names (values are never returned by GitHub). */
async function secretNames() {
  const response = await api(`/repos/${repo}/actions/secrets`);
  const body = await response.json();
  return (body.secrets ?? []).map((entry) => entry.name);
}

const keyResponse = await api(`/repos/${repo}/actions/secrets/public-key`);
if (!keyResponse.ok) {
  console.error(`could not read the repository public key: HTTP ${keyResponse.status}`);
  process.exit(1);
}
const { key, key_id: keyId } = await keyResponse.json();

const put = await api(`/repos/${repo}/actions/secrets/${PROBE_NAME}`, {
  method: "PUT",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({
    encrypted_value: sealBox(nacl, PROBE_VALUE, key),
    key_id: keyId,
  }),
});

if (put.status !== 201 && put.status !== 204) {
  console.error(`GitHub rejected the sealed value: HTTP ${put.status}`);
  console.error((await put.text()).slice(0, 300));
  process.exit(1);
}

const created = (await secretNames()).includes(PROBE_NAME);
const removed = await api(`/repos/${repo}/actions/secrets/${PROBE_NAME}`, { method: "DELETE" });
const cleaned = !(await secretNames()).includes(PROBE_NAME);

console.log(`sealed value accepted: yes (key_id ${keyId})`);
console.log(`secret created: ${created ? "yes" : "no"}`);
console.log(`probe deleted: ${removed.status} / gone: ${cleaned ? "yes" : "no"}`);

if (!created || !cleaned) {
  console.error("the probe did not round-trip cleanly");
  process.exit(1);
}
console.log("OK: the browser can write GitHub Secrets with this implementation.");
