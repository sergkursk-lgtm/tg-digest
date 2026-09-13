/**
 * Tests for PIN-based protection of the GitHub token.
 *
 * The point of this design is that there is no stored PIN hash to steal: the PIN is an
 * encryption key, and a wrong PIN is detected by the GCM authentication tag. These
 * tests pin that behaviour down.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PBKDF2_ITERATIONS,
  VaultError,
  WrongPinError,
  createVault,
  deriveKey,
  openVault,
} from "../frontend/assets/crypto.js";
import { fromBase64 } from "../frontend/assets/bytes.js";

// A low iteration count keeps the suite fast; the production default is asserted below.
const FAST = { iterations: 1000 };
const TOKEN = "github_pat_11ABCDEFG0123456789";

test("a vault round-trips with the right PIN", async () => {
  const vault = await createVault("1234", TOKEN, FAST);
  assert.equal(await openVault("1234", vault), TOKEN);
});

test("a wrong PIN is rejected by the authentication tag", async () => {
  const vault = await createVault("1234", TOKEN, FAST);
  await assert.rejects(() => openVault("4321", vault), WrongPinError);
});

test("a wrong PIN of the same length is still rejected", async () => {
  const vault = await createVault("1111", TOKEN, FAST);
  await assert.rejects(() => openVault("1112", vault), WrongPinError);
});

test("the vault stores nothing readable", async () => {
  const vault = await createVault("1234", TOKEN, FAST);
  const serialized = JSON.stringify(vault);
  assert.ok(!serialized.includes(TOKEN));
  assert.ok(!serialized.includes("1234"));
  assert.deepEqual(
    Object.keys(vault).sort(),
    ["ciphertext", "iterations", "iv", "salt", "version"],
  );
});

test("the production default is 100k PBKDF2 iterations", async () => {
  assert.equal(PBKDF2_ITERATIONS, 100_000);
  const vault = await createVault("1234", TOKEN);
  assert.equal(vault.iterations, 100_000);
});

test("the same PIN and secret produce different vaults", async () => {
  const first = await createVault("1234", TOKEN, FAST);
  const second = await createVault("1234", TOKEN, FAST);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test("salt and iv have the documented sizes", async () => {
  const vault = await createVault("1234", TOKEN, FAST);
  assert.equal(fromBase64(vault.salt).length, 16);
  assert.equal(fromBase64(vault.iv).length, 12);
});

test("an empty PIN is refused rather than silently weak", async () => {
  await assert.rejects(() => createVault("", TOKEN, FAST), VaultError);
});

test("a vault from a newer version is refused", async () => {
  const vault = await createVault("1234", TOKEN, FAST);
  await assert.rejects(() => openVault("1234", { ...vault, version: 99 }), VaultError);
});

test("a missing vault is reported clearly", async () => {
  await assert.rejects(() => openVault("1234", null), VaultError);
});

test("unicode secrets survive", async () => {
  const secret = "ключ-🔑-with-ascii";
  const vault = await createVault("0000", secret, FAST);
  assert.equal(await openVault("0000", vault), secret);
});

test("a long token survives unchanged", async () => {
  const long = "x".repeat(5000);
  const vault = await createVault("1234", long, FAST);
  assert.equal(await openVault("1234", vault), long);
});

test("deriveKey is deterministic for the same PIN and salt", async () => {
  const salt = new Uint8Array(16).fill(7);
  const first = await deriveKey("1234", salt, 1000);
  const second = await deriveKey("1234", salt, 1000);
  const data = new TextEncoder().encode("probe");
  const iv = new Uint8Array(12).fill(1);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, first, data);
  const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, second, ciphertext);
  assert.equal(new TextDecoder().decode(opened), "probe");
});
