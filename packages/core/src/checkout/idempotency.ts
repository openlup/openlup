/**
 * Reference checkout idempotency-key contract.
 *
 * This module validates the shape of a header-bound idempotency key only. The
 * current product checkout validates body `intent.idempotencyKey`, not this
 * header contract; downstream checkout runtimes must explicitly wire this
 * helper before treating the header as authoritative.
 *
 * Callers own any persistence workflow for inserting, replaying, or completing
 * a checkout idempotency record.
 */

/** @beta */
export const CHECKOUT_IDEMPOTENCY_KEY_HEADER = "idempotency-key";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** @beta */
export type CheckoutIdempotencyRejection =
  | { reason: "missing"; message: string }
  | { reason: "malformed"; message: string };

/** @beta */
export function validateCheckoutIdempotencyHeader(
  headerValue: string | undefined | null,
): { ok: true; key: string } | { ok: false; rejection: CheckoutIdempotencyRejection } {
  if (headerValue === undefined || headerValue === null || headerValue.trim().length === 0) {
    return {
      ok: false,
      rejection: {
        reason: "missing",
        message: `Missing required ${CHECKOUT_IDEMPOTENCY_KEY_HEADER} header.`,
      },
    };
  }

  const trimmed = headerValue.trim();
  if (!UUID_V4_PATTERN.test(trimmed)) {
    return {
      ok: false,
      rejection: {
        reason: "malformed",
        message: `${CHECKOUT_IDEMPOTENCY_KEY_HEADER} must be a UUID v4.`,
      },
    };
  }

  return { ok: true, key: trimmed };
}
