import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

/**
 * The unit and the tolerance `check-performance-budgets.ts` enforces, kept beside their guard the
 * way `check-source-size-cap-policy.ts` is kept beside `check-source-size.ts`. The guard owns the
 * manifest walk; this module owns what a byte means and how far past a pin is still acceptable.
 */

/**
 * Performance budgets are measured in brotli-compressed bytes, because the CDN serves brotli and
 * raw file size is a quantity no user ever downloads. Enforcing the raw number priced highly
 * repetitive utility CSS at roughly ten times what a visitor pays for it, which pushed waves into
 * trading real design decisions for bytes that compress away.
 *
 * This approximates what the CDN serves. The contract is that the unit is stable and user-facing,
 * not that it matches the CDN's own encoder settings byte for byte.
 */
export function compressedSize(contents: Buffer): number {
  return brotliCompressSync(contents, {
    params: {
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: contents.length,
    },
  }).length;
}

export const BUDGET_BAND_RATIO = 1.05;
export const BUDGET_BAND_MIN_BYTES = 512;

/**
 * A pin is the value measured on the build that set it, not a ceiling: the guard fails only past a
 * band of 5% or 512 B, whichever is larger. Inside the band the delta is printed and the run
 * passes, so growth is visible before it is blocking, and a wave whose real cost to a visitor is a
 * few hundred bytes does not have to spend a re-pin and a written justification on it.
 *
 * The band is computed from the pin in `config/performance-budgets.json`, never from the previous
 * measurement, so it cannot ratchet: two consecutive sub-band waves are measured against the same
 * static pin and the second one fails. Total drift is capped at one band until a human re-pins.
 */
export function budgetThreshold(pinBytes: number): number {
  return Math.max(Math.floor(pinBytes * BUDGET_BAND_RATIO), pinBytes + BUDGET_BAND_MIN_BYTES);
}

export type BandFacts = { overBytes: number; thresholdBytes: number; withinBand: boolean };

/** One measurement judged against one pin: how far over, where the band ends, and whether it fits. */
export function bandFacts(measuredBytes: number, pinBytes: number): BandFacts {
  const thresholdBytes = budgetThreshold(pinBytes);
  const overBytes = Math.max(0, measuredBytes - pinBytes);
  return { overBytes, thresholdBytes, withinBand: overBytes > 0 && measuredBytes <= thresholdBytes };
}

export function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/** Inside the band the delta is news, not a failure, and the line has to read that way. */
export function describeDelta(label: string, overBytes: number, withinBand: boolean, thresholdBytes: number): string {
  const suffix = `(${overBytes} B over pin, band ends at ${formatBytes(thresholdBytes)})`;
  return withinBand
    ? `${label} over pin but inside the band ${suffix}`
    : `${label} over budget by ${formatBytes(overBytes)} ${suffix}`;
}
