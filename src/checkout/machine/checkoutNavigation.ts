/**
 * Checkout URL builders and resume storage. Read identities locate the exact
 * order; only server-validated continuation credentials authorize its actions.
 */

import { CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS } from "@/domains/commerce/paymentContinuationContracts";

/** Thank-you URL carrying the ids the recap endpoint needs (cross-device). */
export function thankYouUrlFor(
  thankYouPath: string,
  ctx: { orderRef: string; orderId?: string; clientId?: string },
): string {
  const params = new URLSearchParams({ order: ctx.orderRef });
  if (ctx.orderId) params.set("orderId", ctx.orderId);
  if (ctx.clientId) params.set("clientId", ctx.clientId);
  return `${thankYouPath}?${params.toString()}`;
}

/** Failure URL carrying the order ref + id so the failure page can offer recovery. */
export function paymentFailedUrlFor(
  paymentFailedPath: string,
  ctx: {
    orderRef?: string;
    orderId?: string;
    paymentIntentId?: string;
    clientId?: string;
    journeyId?: string;
    reason?: "card_declined" | "expired" | "cancelled" | "technical";
  },
): string {
  const params = new URLSearchParams();
  if (ctx.orderRef) params.set("order", ctx.orderRef);
  if (ctx.orderId) params.set("orderId", ctx.orderId);
  if (ctx.paymentIntentId) params.set("paymentIntentId", ctx.paymentIntentId);
  if (ctx.clientId) params.set("clientId", ctx.clientId);
  if (ctx.journeyId) params.set("journeyId", ctx.journeyId);
  if (ctx.reason) params.set("reason", ctx.reason);
  const qs = params.toString();
  return qs ? `${paymentFailedPath}?${qs}` : paymentFailedPath;
}

export function paymentStatusUrlFor(
  paymentPath: string,
  result: {
    orderRef?: string;
    orderId?: string;
    paymentIntentId?: string;
    clientId?: string;
    providerPaymentId?: string | null;
    reason?: "technical";
  },
): string {
  const params = new URLSearchParams({ order: result.orderRef ?? "" });
  if (result.orderId && result.paymentIntentId && result.clientId) {
    params.set("orderId", result.orderId);
    params.set("paymentIntentId", result.paymentIntentId);
    params.set("clientId", result.clientId);
  }
  if (result.providerPaymentId) params.set("providerPaymentId", result.providerPaymentId);
  if (result.reason) params.set("reason", result.reason);
  return `${paymentPath}?${params.toString()}`;
}

export function accountOrderRetryUrlFor(dashboardPath: string, petId?: string | null): string {
  const params = new URLSearchParams({ zamowienie: "configurator" });
  if (petId) params.set("pet", petId);
  return `${dashboardPath}?${params.toString()}`;
}

export const CHECKOUT_CONTINUATION_KEY = "openlup:payment-continuation:v1";
/**
 * The retired first-generation key. NOTHING writes it and NOTHING reads it; it
 * survives only as a `removeItem` target, so a marker the previous deploy left in
 * a live session is swept rather than resurrected. Exported for the guards that
 * assert it stays empty; four older characterizations still retype the literal,
 * and folding them in is deflation this wave deliberately left alone (it drops
 * the brand baseline out of its stale band, which would turn a checkout refactor
 * into a control-plane re-pin).
 */
export const LEGACY_CHECKOUT_CONTINUATION_KEY = "openlup:stripe-pending:v1";

/**
 * Which side of the provider call this marker was last observed on — the fact
 * that decides whether money can be in flight, and so whether a refresh may
 * route the buyer to the status poller. `action_issued`: the server handed back
 * an action and nothing else happened, so the payment intent has no payment
 * method and a readback would report a refusal that never occurred.
 * `confirm_dispatched`: the buyer committed and the provider was called, so a
 * charge may be live and the wait must be allowed to settle.
 */
export type CheckoutContinuationPhase = "action_issued" | "confirm_dispatched";

export type CheckoutContinuationContext = {
  orderId: string;
  orderRef: string;
  paymentIntentId: string;
  clientId: string;
  journeyId: string;
  /**
   * Which action, if any, a resume may reopen. `"none"` is not "unknown": it is
   * the positive claim that there is none, so the phase alone decides — written
   * by both actionless rails (code entry, where the action is in another app,
   * and the wallet sheet, which confirms in place). The retired marker had no
   * room for this field, nor for an expiry, and so became immortal.
   */
  actionKind: "embedded" | "redirect" | "none";
  /** Stamped on write; absent only pre-deploy, read then as the conservative half. */
  phase?: CheckoutContinuationPhase;
  /**
   * Epoch SECONDS from the shared continuation TTL, stamped on write and absent
   * only on a pre-TTL marker. Client-local — never sent anywhere; the server
   * signs its own independent expiry into the continuation cookie.
   */
  expiresAt?: number;
  /** Epoch seconds at which a wait on THIS marker passed `PAYMENT_WAIT_CAP_MS`.
   *  ⛔ NOT a `phase` — that answers "can money be in flight" and the resume guard
   *  branches on it. Here it inherits the marker's identity and TTL; only a fresh
   *  `persistCheckoutContinuation` re-arms the mount capture. */
  waitExhaustedAt?: number;
};

export type CheckoutContinuationInput = Omit<CheckoutContinuationContext, "expiresAt">;

export function persistCheckoutContinuation(ctx: CheckoutContinuationInput): void {
  // A marker is born when the server issues an action, so that is the default
  // phase; `onConfirmStart` raises it when the buyer actually commits.
  const stamped: CheckoutContinuationContext = {
    ...ctx,
    phase: ctx.phase ?? "action_issued",
    expiresAt: Math.floor(Date.now() / 1000) + CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS,
  };
  try {
    sessionStorage.setItem(CHECKOUT_CONTINUATION_KEY, JSON.stringify(stamped));
    sessionStorage.removeItem(LEGACY_CHECKOUT_CONTINUATION_KEY);
  } catch {
    // sessionStorage unavailable (private mode / quota) — resume simply won't fire.
  }
}

/**
 * Move an EXISTING marker to a new phase, in place. Deliberately not a write: a
 * transition reports on a marker that already exists, and inventing one here is
 * what used to strand a buyer on the poller for a payment intent with no payment
 * method. With no marker present this is a no-op and the card form simply stays.
 */
export function setCheckoutContinuationPhase(phase: CheckoutContinuationPhase): void {
  const current = readCheckoutContinuation();
  if (!current || (current.phase === phase && current.waitExhaustedAt === undefined)) return;
  try {
    sessionStorage.setItem(
      CHECKOUT_CONTINUATION_KEY,
      // ⛔ Retiring the stamp here is safe because `onConfirmStart` — the buyer committing a card — precedes every settle in the same submit, so the stamp is already gone before the OTHER caller runs. That other caller (`onConfirmSettled("retryable")`) does NOT mean something new is in flight: it walks the phase BACK after a pre-dispatch failure the provider never saw. The guard above skips only a genuinely empty write, so a repeat confirm on an already-`confirm_dispatched` marker still retires a stale stamp, or the buyer who just authorized is told we cannot confirm. The marker stays; only the spent claim goes.
      JSON.stringify({ ...current, phase, waitExhaustedAt: undefined }),
    );
  } catch {
    // no-op
  }
}

/** Stamp an EXISTING marker as having outlived its wait. A no-op without one, and
 *  for another order: a deep-linked status page has none, and minting one captures. */
export function markCheckoutContinuationWaitExhausted(
  identity: { orderId: string; paymentIntentId: string },
): void {
  const current = readCheckoutContinuation();
  if (!current || typeof current.waitExhaustedAt === "number") return;
  if (current.orderId !== identity.orderId || current.paymentIntentId !== identity.paymentIntentId) return;
  try {
    sessionStorage.setItem(
      CHECKOUT_CONTINUATION_KEY,
      JSON.stringify({ ...current, waitExhaustedAt: Math.floor(Date.now() / 1000) }),
    );
  } catch {
    // Storage refused: today's behaviour, never a charge.
  }
}

export function clearCheckoutContinuation(): void {
  try {
    sessionStorage.removeItem(CHECKOUT_CONTINUATION_KEY);
    sessionStorage.removeItem(LEGACY_CHECKOUT_CONTINUATION_KEY);
  } catch {
    // no-op
  }
}

export function readCheckoutContinuation(): CheckoutContinuationContext | null {
  try {
    const raw = sessionStorage.getItem(CHECKOUT_CONTINUATION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<CheckoutContinuationContext>;
    if (
      typeof value.orderId === "string" &&
      typeof value.orderRef === "string" &&
      typeof value.paymentIntentId === "string" &&
      typeof value.clientId === "string" &&
      typeof value.journeyId === "string" &&
      (value.actionKind === "embedded" || value.actionKind === "redirect" || value.actionKind === "none")
    ) {
      // A malformed phase or expiry is dropped, not trusted: that lands the
      // marker on the same conservative defaults a pre-deploy one gets.
      return {
        ...(value as CheckoutContinuationContext),
        phase: value.phase === "action_issued" || value.phase === "confirm_dispatched"
          ? value.phase
          : undefined,
        expiresAt: typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
          ? value.expiresAt
          : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

const ACCOUNT_ORDER_RETURN_KEY_PREFIX = "openlup:account-order-return:v2:";
const ACCOUNT_ORDER_RETURN_LATEST_KEY = "openlup:account-order-return:v2:latest";
const LEGACY_ACCOUNT_ORDER_RETURN_KEY = "openlup:account-order-return:v1";

function accountOrderReturnKey(orderId: string): string {
  return `${ACCOUNT_ORDER_RETURN_KEY_PREFIX}${encodeURIComponent(orderId)}`;
}

/**
 * Display context for the in-account payment terminal, stashed before a redirect-
 * based provider (BLIK / PBL) takes the buyer out of the SPA. The success-status
 * params (orderId/paymentIntentId/clientId) ride the return URL; petName +
 * isSubscription don't, so we persist them in localStorage (survives the full
 * provider page reload) to render the cream `OrderSuccessShell` title on re-entry. A
 * cold deep-link with no stash falls back to a generic terminal.
 */
export type AccountOrderReturnContext = {
  orderId: string;
  orderRef: string;
  petName: string;
  isSubscription: boolean;
  petId?: string | null;
};

export function persistAccountOrderReturn(ctx: AccountOrderReturnContext): void {
  try {
    localStorage.setItem(accountOrderReturnKey(ctx.orderId), JSON.stringify(ctx));
    localStorage.setItem(ACCOUNT_ORDER_RETURN_LATEST_KEY, ctx.orderId);
  } catch {
    // localStorage unavailable (private mode / quota) — the terminal degrades to
    // a generic success title; the order + polling are unaffected.
  }
}

export function clearAccountOrderReturn(orderId?: string): void {
  try {
    if (orderId) {
      localStorage.removeItem(accountOrderReturnKey(orderId));
      if (localStorage.getItem(ACCOUNT_ORDER_RETURN_LATEST_KEY) === orderId) {
        localStorage.removeItem(ACCOUNT_ORDER_RETURN_LATEST_KEY);
      }
      return;
    }
    localStorage.removeItem(LEGACY_ACCOUNT_ORDER_RETURN_KEY);
    localStorage.removeItem(ACCOUNT_ORDER_RETURN_LATEST_KEY);
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(ACCOUNT_ORDER_RETURN_KEY_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // no-op
  }
}

/**
 * Read the stash, optionally requiring it to match a given order id (so a stale
 * stash from an earlier order is ignored on a cold deep-link).
 */
export function readAccountOrderReturn(orderId?: string): AccountOrderReturnContext | null {
  try {
    const resolvedOrderId = orderId ?? localStorage.getItem(ACCOUNT_ORDER_RETURN_LATEST_KEY);
    const raw = resolvedOrderId
      ? localStorage.getItem(accountOrderReturnKey(resolvedOrderId)) ??
        localStorage.getItem(LEGACY_ACCOUNT_ORDER_RETURN_KEY)
      : localStorage.getItem(LEGACY_ACCOUNT_ORDER_RETURN_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AccountOrderReturnContext>;
    if (
      typeof value.orderId === "string" &&
      typeof value.orderRef === "string" &&
      typeof value.petName === "string" &&
      typeof value.isSubscription === "boolean" &&
      (value.petId === null || typeof value.petId === "string" || value.petId === undefined)
    ) {
      if (orderId && value.orderId !== orderId) return null;
      return value as AccountOrderReturnContext;
    }
    return null;
  } catch {
    return null;
  }
}
