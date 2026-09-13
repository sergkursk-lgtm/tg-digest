/**
 * BLAKE2b with a configurable digest length.
 *
 * Needed for exactly one thing: GitHub requires secrets to be sealed with libsodium's
 * `crypto_box_seal`, whose nonce is `BLAKE2b(ephemeral_pk || recipient_pk)` truncated to
 * the 24-byte nonce length. `BLAKE2b-24` is NOT the first 24 bytes of `BLAKE2b-512` —
 * the digest length is part of the parameter block, which changes the initialisation
 * vector — so truncation would silently produce a wrong nonce.
 *
 * BigInt is used for clarity; the inputs here are a few dozen bytes, so speed is
 * irrelevant. Verified against the official vectors and against Python's
 * `hashlib.blake2b(digest_size=...)` in `tests/seal.test.mjs`.
 */

const IV = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
];

/** Message schedule: BLAKE2b runs 12 rounds over 10 rows. */
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const MASK64 = (1n << 64n) - 1n;
const BLOCK_BYTES = 128;
const ROUNDS = 12;
const MAX_DIGEST_BYTES = 64;

/** Rotate a 64-bit value right. */
function rotr64(value, shift) {
  return ((value >> shift) | (value << (64n - shift))) & MASK64;
}

/** Read a little-endian unsigned 64-bit integer. */
function readUint64LE(bytes, offset) {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }
  return value;
}

/** The BLAKE2b mixing function G. */
function mix(state, a, b, c, d, x, y) {
  state[a] = (state[a] + state[b] + x) & MASK64;
  state[d] = rotr64(state[d] ^ state[a], 32n);
  state[c] = (state[c] + state[d]) & MASK64;
  state[b] = rotr64(state[b] ^ state[c], 24n);
  state[a] = (state[a] + state[b] + y) & MASK64;
  state[d] = rotr64(state[d] ^ state[a], 16n);
  state[c] = (state[c] + state[d]) & MASK64;
  state[b] = rotr64(state[b] ^ state[c], 63n);
}

/** Compress one 128-byte block into the chaining state. */
function compress(state, block, counter, last) {
  const work = [...state, ...IV];
  work[12] ^= counter & MASK64;
  work[13] ^= (counter >> 64n) & MASK64;
  if (last) {
    work[14] ^= MASK64;
  }

  const words = [];
  for (let index = 0; index < 16; index += 1) {
    words.push(readUint64LE(block, index * 8));
  }

  for (let round = 0; round < ROUNDS; round += 1) {
    const s = SIGMA[round % 10];
    mix(work, 0, 4, 8, 12, words[s[0]], words[s[1]]);
    mix(work, 1, 5, 9, 13, words[s[2]], words[s[3]]);
    mix(work, 2, 6, 10, 14, words[s[4]], words[s[5]]);
    mix(work, 3, 7, 11, 15, words[s[6]], words[s[7]]);
    mix(work, 0, 5, 10, 15, words[s[8]], words[s[9]]);
    mix(work, 1, 6, 11, 12, words[s[10]], words[s[11]]);
    mix(work, 2, 7, 8, 13, words[s[12]], words[s[13]]);
    mix(work, 3, 4, 9, 14, words[s[14]], words[s[15]]);
  }

  for (let index = 0; index < 8; index += 1) {
    state[index] ^= work[index] ^ work[index + 8];
  }
  return state;
}

/**
 * Hash bytes with BLAKE2b.
 * @param {Uint8Array|string} input
 * @param {{dkLen?: number}} [options] digest length in bytes, 1..64 (default 64)
 * @returns {Uint8Array}
 */
export function blake2b(input, options = {}) {
  const dkLen = options.dkLen ?? MAX_DIGEST_BYTES;
  if (!Number.isInteger(dkLen) || dkLen < 1 || dkLen > MAX_DIGEST_BYTES) {
    throw new RangeError(`dkLen must be an integer in 1..${MAX_DIGEST_BYTES}, got ${dkLen}`);
  }

  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("blake2b expects a Uint8Array or a string");
  }

  // Parameter block: digest length, no key, fanout 1, depth 1.
  const state = [...IV];
  state[0] ^= 0x01010000n ^ BigInt(dkLen);

  const blockCount = Math.max(1, Math.ceil(bytes.length / BLOCK_BYTES));
  let counter = 0n;

  for (let index = 0; index < blockCount; index += 1) {
    const start = index * BLOCK_BYTES;
    const chunk = bytes.subarray(start, start + BLOCK_BYTES);
    const block = new Uint8Array(BLOCK_BYTES);
    block.set(chunk);
    counter += BigInt(chunk.length);
    compress(state, block, counter, index === blockCount - 1);
  }

  const digest = new Uint8Array(dkLen);
  for (let index = 0; index < dkLen; index += 1) {
    digest[index] = Number((state[index >> 3] >> BigInt(8 * (index & 7))) & 0xffn);
  }
  return digest;
}
