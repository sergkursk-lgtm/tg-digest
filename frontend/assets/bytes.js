/**
 * Byte helpers shared by the sealing and API modules.
 *
 * They work in both the browser and Node: `btoa`/`atob` exist in both, and Buffer is
 * used as a fallback so the Node tests do not need a DOM shim.
 */

/** Decode base64 into bytes. */
export function fromBase64(value) {
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

/** Encode bytes as base64. */
export function toBase64(bytes) {
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

/** Encode text as UTF-8 bytes. */
export function utf8Encode(text) {
  return new TextEncoder().encode(text);
}

/** Decode UTF-8 bytes into text. */
export function utf8Decode(bytes) {
  return new TextDecoder().decode(bytes);
}
