/**
 * libsodium `crypto_box_seal`, reimplemented for the browser.
 *
 * Why this exists: the first-run wizard writes credentials straight into GitHub
 * Secrets, and that endpoint accepts only a value sealed to the repository public key.
 * WebCrypto has X25519 but no XSalsa20-Poly1305 and no BLAKE2b, so the sealed box is
 * assembled here from a vendored XSalsa20-Poly1305 (`vendor/tweetnacl.js`) and a local
 * BLAKE2b (`./blake2b.js`).
 *
 * Construction, matching libsodium's `crypto_box_seal` byte for byte:
 *
 *     ephemeral = random X25519 keypair
 *     nonce     = BLAKE2b(ephemeral_pk || recipient_pk, dkLen = 24)
 *     box       = crypto_box(message, nonce, recipient_pk, ephemeral_sk)
 *     sealed    = ephemeral_pk || box
 *
 * The nonce is derived, not random, and is not stored in the output — which is why a
 * zero nonce (a common mistake) is rejected by GitHub with "improperly encrypted
 * secret". `tools/verify-seal.mjs` checks this against the live API.
 */

import { blake2b } from "./blake2b.js";

const NONCE_BYTES = 24;
const PUBLIC_KEY_BYTES = 32;

/** Decode base64 into bytes, in both the browser and Node. */
function fromBase64(value) {
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

/** Encode bytes as base64, in both the browser and Node. */
function toBase64(bytes) {
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

/**
 * Derive the sealed-box nonce exactly as libsodium does.
 * @param {Uint8Array} ephemeralPublicKey
 * @param {Uint8Array} recipientPublicKey
 * @returns {Uint8Array} 24 bytes
 */
export function sealedBoxNonce(ephemeralPublicKey, recipientPublicKey) {
  const material = new Uint8Array(PUBLIC_KEY_BYTES * 2);
  material.set(ephemeralPublicKey, 0);
  material.set(recipientPublicKey, PUBLIC_KEY_BYTES);
  return blake2b(material, { dkLen: NONCE_BYTES });
}

/**
 * Seal a value to a recipient public key.
 *
 * @param {object} nacl the vendored tweetnacl namespace (`window.nacl`)
 * @param {string} message the plaintext secret
 * @param {string} recipientPublicKeyBase64 the repository public key from the API
 * @returns {string} base64 sealed box
 */
export function sealBox(nacl, message, recipientPublicKeyBase64) {
  const recipientPublicKey = fromBase64(recipientPublicKeyBase64);
  if (recipientPublicKey.length !== PUBLIC_KEY_BYTES) {
    throw new Error(`recipient key must be ${PUBLIC_KEY_BYTES} bytes, got ${recipientPublicKey.length}`);
  }

  const ephemeral = nacl.box.keyPair();
  const nonce = sealedBoxNonce(ephemeral.publicKey, recipientPublicKey);
  const sharedKey = nacl.box.before(recipientPublicKey, ephemeral.secretKey);
  const boxed = nacl.box.after(new TextEncoder().encode(message), nonce, sharedKey);

  const sealed = new Uint8Array(PUBLIC_KEY_BYTES + boxed.length);
  sealed.set(ephemeral.publicKey, 0);
  sealed.set(boxed, PUBLIC_KEY_BYTES);
  return toBase64(sealed);
}

/**
 * Open a sealed box, used only by the tests to prove the construction is reversible.
 * @param {object} nacl
 * @param {string} sealedBase64
 * @param {Uint8Array} recipientPublicKey
 * @param {Uint8Array} recipientSecretKey
 * @returns {string} the original plaintext
 */
export function openSealedBox(nacl, sealedBase64, recipientPublicKey, recipientSecretKey) {
  const sealed = fromBase64(sealedBase64);
  const ephemeralPublicKey = sealed.subarray(0, PUBLIC_KEY_BYTES);
  const boxed = sealed.subarray(PUBLIC_KEY_BYTES);
  const nonce = sealedBoxNonce(ephemeralPublicKey, recipientPublicKey);
  const sharedKey = nacl.box.before(ephemeralPublicKey, recipientSecretKey);
  const opened = nacl.box.open.after(boxed, nonce, sharedKey);
  if (opened === null) {
    throw new Error("sealed box could not be opened");
  }
  return new TextDecoder().decode(opened);
}

/** Exposed for tests. */
export const SEAL_OVERHEAD_BYTES = PUBLIC_KEY_BYTES + 16;
