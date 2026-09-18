import { createHash, randomBytes } from "node:crypto";

/**
 * Order-scoped checkout-recovery token (W1).
 *
 * A raw token is generated once, embedded in the recovery deep-link, and stored
 * ONLY as its SHA-256 hash (mirrors the dunning recovery-token posture in
 * server/domains/subscription/recoveryTokenHash.ts and the DB write in
 * 20260707100000_commerce_checkout_recovery_tokens.sql).
 */

export interface CheckoutRecoveryTokenContext {
  tokenId: string;
  orderId: string;
  clientId: string;
  /** "subscription_cycle" | "one_time_order" — drives copy + post-pay activation. */
  mode: string;
  status: string;
}

export interface CheckoutRecoveryTokenInspection {
  tokenId: string;
  orderId: string;
  clientId: string;
  /** Null when the token exists but the order row is already gone. */
  mode: string | null;
  status: string | null;
  subscriptionId: string | null;
  tokenState: string;
}

export interface CheckoutRecoveryTokenPort {
  /** Issue a token for an unpaid order. Returns the new token row id. */
  issue(input: { orderId: string; rawToken: string; expiresAt: string }): Promise<string>;
  /** Validate a raw token; returns the order context, or null if invalid/expired/not recoverable. */
  validate(rawToken: string, now?: Date): Promise<CheckoutRecoveryTokenContext | null>;
  /**
   * Inspect a raw token without making it recoverable. Used only to choose a safe
   * customer fallback when validate() returns null.
   */
  inspect(rawToken: string, now?: Date): Promise<CheckoutRecoveryTokenInspection | null>;
}

/** Canonical hash: SHA-256 hex of the raw token (matches the SQL `encode(sha256(...))`). */
export function hashCheckoutRecoveryToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Quoted-printable-safe prefix for the raw token.
 *
 * The recovery deep-link rides in the email as `?token=<rawToken>`. The Polish
 * copy ("Dokończ płatność") forces the body into `Content-Transfer-Encoding:
 * quoted-printable`, where `=` followed by two hex digits is a valid escape
 * (`=7D` → `}`). If a mail transport leaves the URL's `=` separator RAW at a
 * soft-line-break boundary, a HEX-leading token is silently mis-decoded:
 * `?token=7dfdd3…` → `?token}fdd3…`, flipping the separator AND eating two hex
 * chars so the token no longer redeems. A fixed NON-HEX first character makes
 * `=r…` a non-escape, so the link survives intact regardless of the transport.
 * Both mint sites must agree: this TS generator and the SQL enqueue RPC
 * (20260709110000_checkout_recovery_qp_safe_token). The token is opaque to the
 * redeem path (matched by SHA-256 hash), so the prefix round-trips transparently.
 * Regression coverage: checkoutRecoveryLinkQpSafety.test.ts.
 */
export const CHECKOUT_RECOVERY_TOKEN_PREFIX = "rcv_";

/** A 256-bit URL-safe random token for the deep-link, with the QP-safe prefix. */
export function generateCheckoutRecoveryToken(): string {
  return CHECKOUT_RECOVERY_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}
