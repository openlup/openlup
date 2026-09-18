import { createHash } from "node:crypto";
import type { SubscriptionPaymentRecoveryPort, SubscriptionRecoveryTokenEvidence } from "./paymentRecoveryPorts.js";

/**
 * Quoted-printable-safe sentinel prefix for the subscription-dunning recovery
 * token. Mirrors the SQL mint in
 * 20260709130000_subscription_dunning_qp_safe_token.sql, where
 * `subscription_handle_payment_failure_dunning` mints
 * `'rcv_' || <64 hex chars>`.
 *
 * WHY: the recovery deep-link rides as `…/napraw?token=<token>` inside an email
 * body that is quoted-printable-encoded (the live Polish dunning copy has
 * diacritics). In quoted-printable, `=` + two hex digits is a valid escape, so a
 * HEX-LEADING token can be corrupted when a transport leaves the URL's `=`
 * separator raw (`?token=7d…` -> `?token}…`). The leading `r` is NOT a hex digit,
 * so `?token=r…` can never begin a valid `=<2 hex>` escape — see
 * isQpSafeRecoveryLinkToken below. The whole prefixed token is hashed (here and
 * in SQL), so the prefix round-trips transparently.
 */
export const DUNNING_RECOVERY_TOKEN_PREFIX = "rcv_";

/**
 * True when a raw token cannot be mis-decoded as a quoted-printable escape at the
 * `?token=` boundary: the two characters immediately after `?token=` (the first
 * two token chars) are never BOTH hex digits, so `=<first two chars>` is never a
 * valid `=<2 hex>` escape. The `rcv_` sentinel guarantees this (leading `r`).
 */
export function isQpSafeRecoveryLinkToken(token: string): boolean {
  const head = token.slice(0, 2);
  return !/^[0-9A-Fa-f]{2}/.test(head);
}

/**
 * Canonical recovery-token hash: SHA-256 hex of the raw token.
 *
 * Mirrors the DB write in 20260612210000_payment_recovery_sha256.sql
 * (`encode(sha256(convert_to(v_token,'UTF8')),'hex')`) byte-for-byte — both are
 * the lowercase hex of the UTF-8 token bytes. Hashing the WHOLE token means the
 * `rcv_` QP-safe prefix round-trips with no validate-side change.
 */
export function hashRecoveryToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Recovery-token evidence lookup for the pre-check.
 *
 * SHA-256 only. The transitional MD5 read fallback (added in
 * 20260612210000_payment_recovery_sha256.sql so tokens minted before the cutover
 * still resolved) was removed once no in-flight MD5 tokens could remain — see
 * 20260627100000_payment_recovery_drop_md5_fallback.sql, which narrows the RPC
 * lookups to `token_hash = encode(sha256(...))` to match this.
 */
export async function findRecoveryTokenEvidence(
  port: Pick<SubscriptionPaymentRecoveryPort, "findTokenEvidenceByHash">,
  rawToken: string,
): Promise<SubscriptionRecoveryTokenEvidence | null> {
  return port.findTokenEvidenceByHash(hashRecoveryToken(rawToken));
}
