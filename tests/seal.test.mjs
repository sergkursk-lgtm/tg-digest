/**
 * Tests for BLAKE2b and the sealed box used to write GitHub Secrets from the browser.
 *
 * The BLAKE2b vectors come from the official specification and from Python's
 * `hashlib.blake2b(digest_size=...)`; the sealed box is checked for reversibility here
 * and against the live GitHub API by `tools/verify-seal.mjs`.
 *
 * tweetnacl is vendored as a UMD file, so Node loads it through require().
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { blake2b } from "../frontend/assets/blake2b.js";
import {
  SEAL_OVERHEAD_BYTES,
  openSealedBox,
  sealBox,
  sealedBoxNonce,
} from "../frontend/assets/seal.js";

const require = createRequire(import.meta.url);
const nacl = require("../frontend/vendor/tweetnacl.js");

/** Render bytes as lowercase hex. */
function toHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

// -- BLAKE2b ------------------------------------------------------------------

const VECTORS = [
  // Official BLAKE2b-512 vectors.
  [
    "",
    64,
    "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419" +
      "d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce",
  ],
  [
    "abc",
    64,
    "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d" +
      "17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
  ],
  // 24-byte digests, the length the sealed-box nonce needs. These are NOT prefixes of
  // the 512-bit digests above, which is the whole point of this implementation.
  ["", 24, "ab3b5331a7135ed50d0f182d026e60abdb3646fd51bcf8a3"],
  ["abc", 24, "56a17e38cc371a46b12c32f18e0c61de2a84e9c2555b114e"],
  ["x".repeat(128), 24, "4f86ba5d9bdbf8cfddf0873d09ce49d70f29403e02c12775"],
  // A 32-byte digest of 129 bytes: the only case with a partial second block.
  ["x".repeat(129), 32, "03b0758fa71d249c846c2304a2b9996e6ae66ffa7e5528f9e612e089a360fc8d"],
];

for (const [input, dkLen, expected] of VECTORS) {
  test(`blake2b(${dkLen} bytes, ${input.length} chars)`, () => {
    assert.equal(toHex(blake2b(input, { dkLen })), expected);
  });
}

test("blake2b defaults to 64 bytes", () => {
  assert.equal(blake2b("abc").length, 64);
});

test("blake2b accepts bytes as well as text", () => {
  assert.equal(toHex(blake2b(new TextEncoder().encode("abc"), { dkLen: 24 })),
    "56a17e38cc371a46b12c32f18e0c61de2a84e9c2555b114e");
});

test("blake2b rejects an impossible digest length", () => {
  assert.throws(() => blake2b("abc", { dkLen: 0 }), RangeError);
  assert.throws(() => blake2b("abc", { dkLen: 65 }), RangeError);
});

test("blake2b rejects a non-bytes input", () => {
  assert.throws(() => blake2b(42), TypeError);
});

test("a 24-byte digest is not a truncated 64-byte digest", () => {
  // Guards the mistake this module exists to avoid.
  const short = toHex(blake2b("abc", { dkLen: 24 }));
  const long = toHex(blake2b("abc", { dkLen: 64 }));
  assert.notEqual(short, long.slice(0, 48));
});

// -- sealed box ---------------------------------------------------------------

test("nonce is derived from both public keys", () => {
  const ephemeral = nacl.box.keyPair();
  const recipient = nacl.box.keyPair();
  const nonce = sealedBoxNonce(ephemeral.publicKey, recipient.publicKey);
  assert.equal(nonce.length, 24);

  // Order matters: swapping the keys must change the nonce.
  const swapped = sealedBoxNonce(recipient.publicKey, ephemeral.publicKey);
  assert.notEqual(toHex(nonce), toHex(swapped));
});

test("sealed box round-trips and grows by the sealing overhead", () => {
  const recipient = nacl.box.keyPair();
  const publicKeyBase64 = Buffer.from(recipient.publicKey).toString("base64");
  const sealed = sealBox(nacl, "sk-test-value", publicKeyBase64);

  const opened = openSealedBox(nacl, sealed, recipient.publicKey, recipient.secretKey);
  assert.equal(opened, "sk-test-value");

  const sealedBytes = Buffer.from(sealed, "base64").length;
  assert.equal(sealedBytes, "sk-test-value".length + SEAL_OVERHEAD_BYTES);
});

test("sealing is randomised: the same value gives a different box", () => {
  const recipient = nacl.box.keyPair();
  const publicKeyBase64 = Buffer.from(recipient.publicKey).toString("base64");
  assert.notEqual(sealBox(nacl, "same", publicKeyBase64), sealBox(nacl, "same", publicKeyBase64));
});

test("only the intended recipient can open the box", () => {
  const recipient = nacl.box.keyPair();
  const stranger = nacl.box.keyPair();
  const sealed = sealBox(nacl, "secret", Buffer.from(recipient.publicKey).toString("base64"));
  assert.throws(
    () => openSealedBox(nacl, sealed, stranger.publicKey, stranger.secretKey),
    /could not be opened/,
  );
});

test("sealBox rejects a key of the wrong size", () => {
  assert.throws(() => sealBox(nacl, "x", Buffer.from("short").toString("base64")),
    /recipient key must be 32 bytes/);
});

test("unicode secrets survive sealing", () => {
  const recipient = nacl.box.keyPair();
  const sealed = sealBox(nacl, "ключ-🔑", Buffer.from(recipient.publicKey).toString("base64"));
  assert.equal(
    openSealedBox(nacl, sealed, recipient.publicKey, recipient.secretKey),
    "ключ-🔑",
  );
});
