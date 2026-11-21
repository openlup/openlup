const DEFAULT_LOW_STOCK_THRESHOLD = 3;
const MAX_BUNDLE_LOW_STOCK_THRESHOLD = 2147483647;

/** Validates a bundle low-stock threshold (non-negative 32-bit integer) or returns the supplied default. */
export function validateBundleLowStockThreshold(
  threshold: number | undefined,
  fallback = DEFAULT_LOW_STOCK_THRESHOLD,
): number {
  if (threshold === undefined) return fallback;
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > MAX_BUNDLE_LOW_STOCK_THRESHOLD) {
    throw new RangeError(
      `bundle_low_stock_threshold_invalid: expected an integer from 0 to ${MAX_BUNDLE_LOW_STOCK_THRESHOLD}`,
    );
  }
  return threshold;
}
