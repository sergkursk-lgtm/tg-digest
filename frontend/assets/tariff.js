/**
 * Peak / off-peak tariff logic for the UI footer.
 *
 * This mirrors `backend/pricing.py`, which stays the single source of truth for
 * money. The browser needs its own copy only to render the "peak / off-peak"
 * indicator without a round trip; the authoritative cost is always computed by
 * the backend and stored with the digest.
 *
 * Rules (checked 2026-09-13, https://api-docs.deepseek.com/quick_start/pricing):
 *   - peak: Monday-Friday, 01:00-04:00 and 06:00-10:00 UTC
 *   - everything else, including all weekend hours, is off-peak
 *   - peak prices are exactly 2x off-peak prices
 */

export const MODEL = "deepseek-flash";
export const PEAK_MULTIPLIER = 2;

/** Half-open UTC windows [startHour, endHour) that count as peak on weekdays. */
export const PEAK_WINDOWS_UTC = [
  [1, 4],
  [6, 10],
];

/** Off-peak prices in USD per 1M tokens. */
export const OFF_PEAK_PRICES_USD_PER_MTOKEN = {
  cache_hit: 0.003,
  input: 0.15,
  output: 0.6,
};

const MINUTE_MS = 60_000;

/**
 * Return true when `moment` falls into a DeepSeek peak-price window.
 * @param {Date} moment - any Date; it is evaluated in UTC.
 * @returns {boolean}
 */
export function isPeak(moment) {
  const day = moment.getUTCDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) {
    return false;
  }
  const hour = moment.getUTCHours();
  return PEAK_WINDOWS_UTC.some(([start, end]) => hour >= start && hour < end);
}

/**
 * Describe the tariff in effect at `moment`.
 * @param {Date} moment
 * @returns {{model: string, tariff: "peak"|"off_peak", multiplier: number,
 *            pricesUsdPerMtoken: Record<string, number>, nextChange: Date}}
 */
export function tariffSnapshot(moment) {
  const peak = isPeak(moment);
  const pricesUsdPerMtoken = {};
  for (const [tokenClass, price] of Object.entries(OFF_PEAK_PRICES_USD_PER_MTOKEN)) {
    pricesUsdPerMtoken[tokenClass] = peak ? price * PEAK_MULTIPLIER : price;
  }
  return {
    model: MODEL,
    tariff: peak ? "peak" : "off_peak",
    multiplier: peak ? PEAK_MULTIPLIER : 1,
    pricesUsdPerMtoken,
    nextChange: nextTariffChange(moment),
  };
}

/**
 * Return the next instant at which the tariff actually flips.
 *
 * Boundaries that land on a weekend change nothing, so they are skipped:
 * from Friday 23:00 UTC the next real switch is Monday 01:00 UTC.
 * @param {Date} moment
 * @returns {Date}
 */
export function nextTariffChange(moment) {
  const currentPeak = isPeak(moment);
  const midnight = Date.UTC(
    moment.getUTCFullYear(),
    moment.getUTCMonth(),
    moment.getUTCDate(),
  );

  for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
    for (const [start, end] of PEAK_WINDOWS_UTC) {
      for (const hour of [start, end]) {
        const boundary = new Date(midnight + dayOffset * 24 * 3_600_000 + hour * 3_600_000);
        if (boundary.getTime() > moment.getTime() && isPeak(boundary) !== currentPeak) {
          return boundary;
        }
      }
    }
  }
  throw new Error("tariff never changes within a week; peak windows are broken");
}

/**
 * Human-readable Russian label for the indicator.
 * @param {Date} moment
 * @returns {string}
 */
export function tariffLabel(moment) {
  const snapshot = tariffSnapshot(moment);
  const minutes = Math.round((snapshot.nextChange.getTime() - moment.getTime()) / MINUTE_MS);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const until = hours > 0 ? `${hours} ч ${rest} мин` : `${rest} мин`;
  return snapshot.tariff === "peak"
    ? `Peak ×2 — до ${formatUtcTime(snapshot.nextChange)} UTC (${until})`
    : `Off-peak — до ${formatUtcTime(snapshot.nextChange)} UTC (${until})`;
}

/**
 * Format a Date as HH:MM UTC.
 * @param {Date} moment
 * @returns {string}
 */
export function formatUtcTime(moment) {
  return `${String(moment.getUTCHours()).padStart(2, "0")}:${String(
    moment.getUTCMinutes(),
  ).padStart(2, "0")}`;
}
