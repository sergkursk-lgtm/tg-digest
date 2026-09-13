/**
 * Mirror of the backend peak/off-peak tests, run with `node --test`.
 *
 * The browser copy of the tariff rules must never drift from backend/pricing.py:
 * if it does, the footer starts lying about what a digest will cost.
 *
 * Lives outside `frontend/` on purpose, so it is not published to GitHub Pages.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isPeak,
  nextTariffChange,
  tariffLabel,
  tariffSnapshot,
} from "../frontend/assets/tariff.js";

/** Build a Date from a UTC calendar moment. */
function utc(year, month, day, hour, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

// 2026-09-14 is a Monday, 2026-09-19 a Saturday, 2026-09-20 a Sunday.
const cases = [
  [utc(2026, 9, 14, 0, 59), false, "just before the first peak window"],
  [utc(2026, 9, 14, 1, 0), true, "window start, inclusive"],
  [utc(2026, 9, 14, 2, 30), true, "inside the window"],
  [utc(2026, 9, 14, 3, 59), true, "last peak minute"],
  [utc(2026, 9, 14, 4, 0), false, "window end, exclusive"],
  [utc(2026, 9, 14, 5, 59), false, "gap between windows"],
  [utc(2026, 9, 14, 6, 0), true, "second window start"],
  [utc(2026, 9, 14, 9, 59), true, "last peak minute of the second window"],
  [utc(2026, 9, 14, 10, 0), false, "second window end"],
  [utc(2026, 9, 14, 23, 59), false, "weekday night"],
  [utc(2026, 9, 19, 2, 0), false, "Saturday is always off-peak"],
  [utc(2026, 9, 20, 7, 0), false, "Sunday is always off-peak"],
];

for (const [moment, expected, label] of cases) {
  test(`isPeak: ${label}`, () => {
    assert.equal(isPeak(moment), expected);
  });
}

test("tariffSnapshot marks peak and doubles every price", () => {
  const snapshot = tariffSnapshot(utc(2026, 9, 14, 2, 0));
  assert.equal(snapshot.tariff, "peak");
  assert.equal(snapshot.multiplier, 2);
  assert.deepEqual(snapshot.pricesUsdPerMtoken, {
    cache_hit: 0.006,
    input: 0.3,
    output: 1.2,
  });
});

test("tariffSnapshot keeps off-peak prices as published", () => {
  const snapshot = tariffSnapshot(utc(2026, 9, 19, 12, 0));
  assert.equal(snapshot.tariff, "off_peak");
  assert.deepEqual(snapshot.pricesUsdPerMtoken, {
    cache_hit: 0.003,
    input: 0.15,
    output: 0.6,
  });
});

test("nextTariffChange from a weekday night is 01:00 UTC", () => {
  assert.equal(
    nextTariffChange(utc(2026, 9, 14, 0, 30)).toISOString(),
    "2026-09-14T01:00:00.000Z",
  );
});

test("nextTariffChange skips the weekend", () => {
  assert.equal(
    nextTariffChange(utc(2026, 9, 18, 23, 0)).toISOString(),
    "2026-09-21T01:00:00.000Z",
  );
});

test("tariffLabel renders a Russian countdown", () => {
  assert.match(tariffLabel(utc(2026, 9, 14, 2, 0)), /^Peak ×2 — до 04:00 UTC \(2 ч 0 мин\)$/);
  assert.match(tariffLabel(utc(2026, 9, 19, 12, 0)), /^Off-peak — до 01:00 UTC/);
});
