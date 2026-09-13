/**
 * Tests for the icon.
 *
 * The artwork is checked by its shape, not by its bytes: the SVG has to stay a plain square
 * viewBox with no text, and the PNGs have to be the sizes the names promise. Both are the
 * kind of thing that silently drifts when someone re-exports an asset.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const ROOT = new URL("../", import.meta.url);

/** Read the width and height out of a PNG's IHDR chunk. */
function pngSize(buffer) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (const [index, byte] of signature.entries()) {
    assert.equal(buffer[index], byte, "not a PNG");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test("the icon is one square, text-free vector", async () => {
  const svg = await readFile(new URL("frontend/branding/icon.svg", ROOT), "utf8");
  assert.match(svg, /viewBox="0 0 512 512"/);
  assert.match(svg, /width="512"/);
  // Text in an icon is unreadable at 24px and untranslatable; there is none.
  assert.ok(!/<text/.test(svg), "the icon must not contain text");
  // The accent blue of the interface, so the icon and the app match.
  assert.match(svg, /#2563eb/);
});

test("every rendered size is what its name says", async () => {
  for (const [name, size] of [
    ["icon-512.png", 512],
    ["icon-192.png", 192],
    ["icon-180.png", 180],
  ]) {
    const buffer = await readFile(new URL(`frontend/branding/${name}`, ROOT));
    const measured = pngSize(buffer);
    assert.equal(measured.width, size, `${name} width`);
    assert.equal(measured.height, size, `${name} height`);
  }
});

test("the page uses the icon file rather than a copy of it", async () => {
  const html = await readFile(new URL("frontend/index.html", ROOT), "utf8");
  assert.match(html, /rel="icon" href="\.\/branding\/icon\.svg"/);
  assert.match(html, /rel="apple-touch-icon" href="\.\/branding\/icon-180\.png"/);
  // A data URI would be a second copy of the artwork, free to drift from the file.
  assert.ok(!/rel="icon"[^>]*data:image/.test(html), "the favicon must not be inlined");
});
