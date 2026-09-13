/**
 * PIN protection for the GitHub token.
 *
 * The PIN is not compared against a stored hash — a stored hash can be stolen along
 * with everything else. Instead the PIN is stretched with PBKDF2-SHA256 and used as an
 * AES-GCM key that *encrypts the token itself*:
 *
 *     localStorage: { iterations, salt, iv, ciphertext }   — and nothing else
 *
 * A wrong PIN simply fails to decrypt: the GCM authentication tag rejects it, so no
 * separate verifier is needed and there is nothing to compare against. Forgetting the
 * PIN costs nothing but re-entering the token, because the token is the real secret.
 *
 * Honest limit: this protects the token from someone who opens the browser later. It
 * does not protect against script running in the page while it is unlocked, which is
 * why digest HTML is sanitised before it ever reaches the DOM.
 */

import { fromBase64, toBase64, utf8Decode, utf8Encode } from "./bytes.js";

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;
const VAULT_VERSION = 1;

export { PBKDF2_ITERATIONS };

/** Raised when the PIN does not decrypt the stored token. */
export class WrongPinError extends Error {
  constructor() {
    super("неверный PIN");
    this.name = "WrongPinError";
  }
}

/** Raised when a stored vault is malformed or was written by a newer version. */
export class VaultError extends Error {
  constructor(message) {
    super(message);
    this.name = "VaultError";
  }
}

/**
 * Stretch a PIN into an AES-GCM key.
 * @param {string} pin
 * @param {Uint8Array} salt
 * @param {number} [iterations]
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(pin, salt, iterations = PBKDF2_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    "raw",
    utf8Encode(pin),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: KEY_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a secret under a PIN.
 * @param {string} pin
 * @param {string} secret
 * @param {{iterations?: number}} [options] iteration count, lowered only by tests
 * @returns {Promise<{version: number, iterations: number, salt: string, iv: string,
 *                    ciphertext: string}>}
 */
export async function createVault(pin, secret, options = {}) {
  if (!pin) {
    throw new VaultError("PIN не может быть пустым");
  }
  const iterations = options.iterations ?? PBKDF2_ITERATIONS;
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(pin, salt, iterations);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    utf8Encode(secret),
  );

  return {
    version: VAULT_VERSION,
    iterations,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Decrypt a vault with a PIN.
 *
 * @param {string} pin
 * @param {{version: number, iterations: number, salt: string, iv: string, ciphertext: string}} vault
 * @returns {Promise<string>} the original secret
 * @throws {WrongPinError} when the PIN is wrong
 * @throws {VaultError} when the vault itself is unusable
 */
export async function openVault(pin, vault) {
  if (!vault || typeof vault !== "object") {
    throw new VaultError("хранилище не найдено");
  }
  if (vault.version !== VAULT_VERSION) {
    throw new VaultError(`версия хранилища ${vault.version} не поддерживается`);
  }

  let plaintext;
  try {
    const key = await deriveKey(pin, fromBase64(vault.salt), vault.iterations);
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(vault.iv) },
      key,
      fromBase64(vault.ciphertext),
    );
  } catch (error) {
    // A bad tag is indistinguishable from a corrupt vault; both mean "cannot open".
    throw new WrongPinError();
  }
  return utf8Decode(new Uint8Array(plaintext));
}
