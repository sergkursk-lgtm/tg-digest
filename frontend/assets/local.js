/**
 * Where the UI keeps its own state.
 *
 * Only two things live in localStorage:
 *
 *   tg-digest.repo   which repository to talk to (not a secret)
 *   tg-digest.vault  the GitHub token, encrypted with the PIN (see crypto.js)
 *
 * Nothing else is persisted locally. Channels, settings and digests live in the private
 * data branch so that they are available from any browser.
 */

const REPO_KEY = "tg-digest.repo";
const VAULT_KEY = "tg-digest.vault";

/** Default target of the UI; the wizard lets it be changed. */
export const DEFAULT_REPO = "sergkursk-lgtm/tg-digest-core";

/** Read a JSON value, tolerating an unavailable or corrupt store. */
function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

/** Write a JSON value, tolerating storage being unavailable. */
function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    return false;
  }
}

/** Read the repository coordinates, falling back to the default. */
export function loadRepo() {
  const stored = readJson(REPO_KEY);
  if (stored && typeof stored.owner === "string" && typeof stored.repo === "string") {
    return { owner: stored.owner, repo: stored.repo };
  }
  return parseRepo(DEFAULT_REPO);
}

/** Persist the repository coordinates. */
export function saveRepo(owner, repo) {
  return writeJson(REPO_KEY, { owner, repo });
}

/** Split "owner/name" into its parts, rejecting anything that is not exactly that. */
export function parseRepo(value) {
  const parts = String(value ?? "").trim().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("укажите репозиторий в виде owner/name");
  }
  return { owner: parts[0], repo: parts[1] };
}

/** Read the encrypted token vault. */
export function loadVault() {
  return readJson(VAULT_KEY);
}

/** Store the encrypted token vault. */
export function saveVault(vault) {
  return writeJson(VAULT_KEY, vault);
}

/** Forget the vault, for example when the PIN is lost. */
export function clearVault() {
  try {
    localStorage.removeItem(VAULT_KEY);
    return true;
  } catch (error) {
    return false;
  }
}
