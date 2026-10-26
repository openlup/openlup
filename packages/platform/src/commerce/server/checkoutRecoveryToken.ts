import { createHash, randomBytes } from "node:crypto";

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

/** Inspection RPC states; only the named continuation states may resume pending orders. */
export function classifyCheckoutRecoveryTokenState(
  tokenState: string,
): "continuation" | "expired_policy" | "refused" {
  switch (tokenState) {
    case "active":
    case "order_not_recoverable":
      return "continuation";
    case "expired":
      return "expired_policy";
    case "revoked":
    case "used":
    case "order_not_found":
    default:
      return "refused";
  }
}

export interface CheckoutRecoveryTokenPort {
  /** Issue a token for an unpaid order. Returns the new token row id. */
  issue(input: { orderId: string; rawToken: string; expiresAt: string }): Promise<string>;
  /** Validate a raw token; returns the order context, or null if invalid/expired/not recoverable. */
  validate(rawToken: string, now?: Date): Promise<CheckoutRecoveryTokenContext | null>;
  /**
   * Inspect without granting continuation; callers must check state before reconstructing authority.
   */
  inspect(rawToken: string, now?: Date): Promise<CheckoutRecoveryTokenInspection | null>;
}

/** Canonical hash: SHA-256 hex of the raw token (matches the SQL `encode(sha256(...))`). */
export function hashCheckoutRecoveryToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A non-hex prefix keeps quoted-printable mail transports from consuming the URL separator. */
export const CHECKOUT_RECOVERY_TOKEN_PREFIX = "rcv_";

/** A 256-bit URL-safe random token for the deep-link, with the QP-safe prefix. */
export function generateCheckoutRecoveryToken(): string {
  return CHECKOUT_RECOVERY_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}
