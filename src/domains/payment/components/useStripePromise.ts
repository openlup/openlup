import { useCallback, useEffect, useMemo, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";

import { reportCheckoutClientEvent } from "@/lib/telemetry/checkoutClientEvent";

/**
 * How long the browser may spend fetching the PSP's JS bundle before the load is
 * declared failed. An in-app webview (the 2026-08-26 report came from one) can
 * leave the request hanging indefinitely rather than erroring, and an unresolved
 * promise renders as a permanently disabled pay button with nothing on screen to
 * explain it. A bounded wait turns that into a message the buyer can act on.
 */
export const STRIPE_LOAD_TIMEOUT_MS = 10_000;

export type StripeLoadStatus = "unconfigured" | "loading" | "ready" | "failed";

/**
 * Rejection message the timeout arm raises.
 *
 * {@link StripeLoadStatus} folds a timed-out load and a refused one into a
 * single `failed`, on purpose: the buyer is told the same thing either way. The
 * two are not the same incident for US, though — a refusal is usually a blocked
 * script, a timeout is usually a webview that never answers — and this marker is
 * the only place the difference still exists. It is read once, where the
 * telemetry code is chosen, rather than widened into the public state.
 */
const LOAD_TIMEOUT_REJECTION = "stripe_js_load_timeout";

export interface StripeLoaderState {
  /** `null` only when no publishable key is configured at build time. */
  stripePromise: Promise<Stripe | null> | null;
  status: StripeLoadStatus;
  /** Starts a genuinely new attempt; a failed load is never replayed from cache. */
  retry: () => void;
}

let cachedStripePromise: Promise<Stripe | null> | null = null;

function loadStripeWithTimeout(publishableKey: string): Promise<Stripe | null> {
  return new Promise<Stripe | null>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(LOAD_TIMEOUT_REJECTION)),
      STRIPE_LOAD_TIMEOUT_MS,
    );
    loadStripe(publishableKey).then(
      (stripe) => {
        clearTimeout(timer);
        resolve(stripe);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("stripe_js_load_failed"));
      },
    );
  });
}

/**
 * Shared, cached Stripe.js load for the build-time
 * `VITE_STRIPE_PUBLISHABLE_KEY`. The bundle is fetched at most once per session
 * and shared by every Stripe surface (card Payment Element, Express Checkout
 * wallets).
 *
 * ⛔ A FAILED load must not be cached. The previous version stored whatever
 * `loadStripe` returned, so a single rejection — one flaky moment in a webview —
 * left every later mount holding the same rejected promise for the rest of the
 * session, with no way back other than a full reload. Eviction on failure is
 * what makes {@link StripeLoaderState.retry} mean anything.
 *
 * SAFETY: only the publishable key (`pk_test_…` / `pk_live_…`) is read here; the
 * server-side secret key must never reach the browser bundle.
 */
function startStripeLoad(): Promise<Stripe | null> | null {
  if (cachedStripePromise) return cachedStripePromise;
  const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey || typeof publishableKey !== "string") return null;
  const promise = loadStripeWithTimeout(publishableKey);
  cachedStripePromise = promise;
  const evict = () => {
    if (cachedStripePromise === promise) cachedStripePromise = null;
  };
  // A resolved-but-empty load is just as unusable as a rejected one, so both
  // arms evict. The rejection arm additionally OWNS the rejection, which is what
  // keeps a consumer that only forwards the promise to `<Elements stripe={…}>`
  // from producing an unhandled rejection.
  promise.then((stripe) => { if (!stripe) evict(); }, evict);
  return promise;
}

/** Test-only reset of the module-level cache. */
export function resetStripePromiseCacheForTests(): void {
  cachedStripePromise = null;
}

/**
 * The load with its outcome exposed, for surfaces that must tell the buyer why
 * the card form is not there.
 */
export function useStripeLoader(): StripeLoaderState {
  const [attempt, setAttempt] = useState(0);
  const stripePromise = useMemo(() => {
    void attempt; // a retry deliberately re-reads the (possibly evicted) cache
    return startStripeLoad();
  }, [attempt]);
  const [status, setStatus] = useState<StripeLoadStatus>(
    stripePromise ? "loading" : "unconfigured",
  );

  useEffect(() => {
    if (!stripePromise) {
      setStatus("unconfigured");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    stripePromise.then(
      (stripe) => {
        // `loadStripe` resolving to `null` means the script did not produce an
        // instance. There is no card form either way, so it is a failure the
        // buyer must be told about, not a silent no-op.
        //
        // BOTH arms report. A load that succeeded is the first bracket the seam
        // hunt needs: a payment step with no `psp_js_load_ok` at all never had a
        // card form for the buyer to fail in.
        reportCheckoutClientEvent(
          "psp_loader",
          stripe ? "psp_js_load_ok" : "psp_js_load_failed",
        );
        if (!cancelled) setStatus(stripe ? "ready" : "failed");
      },
      (error: unknown) => {
        // Reported OUTSIDE the `cancelled` guard, unlike the state write. That
        // guard exists to avoid setting state on an unmounted hook; it says
        // nothing about whether the load failed. A buyer who gave up and
        // navigated away during a hanging load is the exact case this wave was
        // opened for, and suppressing it would re-create the silence.
        reportCheckoutClientEvent(
          "psp_loader",
          error instanceof Error && error.message === LOAD_TIMEOUT_REJECTION
            ? "psp_js_load_timeout"
            : "psp_js_load_failed",
        );
        if (!cancelled) setStatus("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [stripePromise]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  return { stripePromise, status, retry };
}

/**
 * Backward-compatible projection of {@link useStripeLoader}: the promise alone,
 * `null` when no publishable key is configured. Existing non-checkout account
 * surfaces still consume this signature; checkout wallets use the stateful
 * loader so timeout recovery is visible and retryable.
 */
export function useStripePromise(): Promise<Stripe | null> | null {
  return useStripeLoader().stripePromise;
}
