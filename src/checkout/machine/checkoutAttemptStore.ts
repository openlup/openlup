import type { ConfiguratorIntent } from "@/domains/commerce/configuratorIntentContracts";
import type { CheckoutQuoteExpectation } from "@/checkout/composer/configuratorFormStore";

export const CHECKOUT_ATTEMPT_STORAGE_KEY = "openlup:skomponuj-pakiet:checkout-attempt:v1";

interface StoredCheckoutAttempt {
  fingerprint: string;
  key: string;
  /** Which payment attempt this journey is on. Absent means the first. */
  paymentAttempt?: number;
}

export function getOrCreateCheckoutAttemptKey(
  intent: ConfiguratorIntent,
  expectedQuote?: CheckoutQuoteExpectation | null,
): string {
  // Journey-stable key: minted ONCE per configurator session and reused across
  // cart edits and retries. It changes ONLY when explicitly cleared on a terminal
  // outcome (paid / reset) — NEVER on a payload change.
  //
  // Rotating on every cart edit (the old behaviour) defeated server-side dedup:
  // persist-intent and order-draft are keyed on this idempotencyKey, so a rotated
  // key minted a fresh pet + order + subscription per edit (the duplicate cascade).
  // The server now treats a same-key / changed-payload submit as an idempotent
  // update-in-place, so a stable key means one journey => exactly one pet + order +
  // subscription. See docs/plan/fix-checkout-idempotency-journey-key.md.
  const stored = readStoredAttempt();
  if (stored && isCheckoutAttemptKey(stored.key)) {
    return stored.key;
  }

  const key = `checkout:${crypto.randomUUID()}`;
  writeStoredAttempt({ fingerprint: fingerprintCheckoutIntent(intent, expectedQuote), key });
  return key;
}

/**
 * Which payment attempt the current journey is on.
 *
 * Paired with the journey key rather than replacing it: the key must stay stable
 * so one journey yields exactly one pet/order/subscription, while the attempt
 * sequence gives each retry its own provider-attempt identity.
 */
export function readCheckoutPaymentAttempt(): number {
  return readStoredAttempt()?.paymentAttempt ?? 0;
}

/**
 * Records that the current attempt is dead and the next one needs a fresh
 * identity.
 *
 * Called on a terminal decline, NOT on the buyer merely editing the cart. The
 * declined order deliberately stays `pending_payment` and re-payable, so a retry
 * must land on that same order — minting a new one would leave a payable
 * duplicate with a recovery email already in flight. Without the bump, retrying
 * (above all with a different provider) collides with the dead attempt's prepare
 * key and fails instead of charging.
 */
export function bumpCheckoutPaymentAttempt(): void {
  const stored = readStoredAttempt();
  if (!stored) return;
  writeStoredAttempt({ ...stored, paymentAttempt: (stored.paymentAttempt ?? 0) + 1 });
}

export function clearCheckoutAttemptKey(): void {
  getSessionStorage()?.removeItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
}

export function fingerprintCheckoutIntent(
  intent: ConfiguratorIntent,
  expectedQuote?: CheckoutQuoteExpectation | null,
): string {
  // Diagnostic stamp only: recorded alongside the key at mint time so a stored
  // attempt can be traced back to the payload that first created it. It NO LONGER
  // gates key rotation — the journey key is stable across payload changes and the
  // server dedups by update-in-place (see getOrCreateCheckoutAttemptKey). Excludes
  // the idempotency key itself (derived from this fingerprint — chicken-and-egg).
  const { idempotencyKey: _idempotencyKey, ...fingerprintSource } = intent;
  const policy = expectedQuote?.pricingPolicy;
  return stableStringify({
    intent: fingerprintSource,
    expectedQuote: expectedQuote ? {
      totalGross: expectedQuote.totalGross,
      ...(policy ? { pricingPolicy: {
        offerPolicyVersion: policy.offerPolicyVersion,
        promotionEngineVersion: policy.promotionEngineVersion,
      } } : {}),
    } : null,
  });
}

function readStoredAttempt(): StoredCheckoutAttempt | null {
  const raw = getSessionStorage()?.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredCheckoutAttempt>;
    if (typeof parsed.fingerprint !== "string" || typeof parsed.key !== "string") return null;
    return {
      fingerprint: parsed.fingerprint,
      key: parsed.key,
      paymentAttempt: typeof parsed.paymentAttempt === "number" ? parsed.paymentAttempt : 0,
    };
  } catch {
    return null;
  }
}

function writeStoredAttempt(attempt: StoredCheckoutAttempt): void {
  getSessionStorage()?.setItem(CHECKOUT_ATTEMPT_STORAGE_KEY, JSON.stringify(attempt));
}

function isCheckoutAttemptKey(value: string): boolean {
  return /^checkout:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
