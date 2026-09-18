import { createStripeApiClient } from "./stripeApiClient.js";
import { assertStripeKeyMode } from "../providerReadiness.js";
import type { StripeSandboxClient } from "../../adapters/stripe/stripeSandboxPaymentExecutionAdapter.js";

/**
 * Wave D-4a — returns a Stripe API client when `STRIPE_PROVIDER_ENABLED=true`
 * and a secret key is configured; `null` otherwise.
 *
 * Mirrors `buildStripeAdapterIfEnabled` (which returns a `PaymentExecutionPort`
 * built on top of the same client) but exposes the raw client so BFF routes
 * that need to mint a SetupIntent for the recovery flow can do so without
 * going through the execution-port abstraction (the execution port is shaped
 * for charge dispatch, not arbitrary intent creation).
 *
 * `assertStripeKeyMode` enforces sandbox-only by default — an `sk_live_` key
 * requires explicit `STRIPE_LIVE_CONFIRMED=true` to unlock.
 */
export function buildStripeApiClientIfEnabled(
  env: Record<string, string | undefined>,
): StripeSandboxClient | null {
  if (env.STRIPE_PROVIDER_ENABLED !== "true") return null;
  if (!env.STRIPE_SECRET_KEY) return null;
  assertStripeKeyMode(env.STRIPE_SECRET_KEY, env);
  return createStripeApiClient({ secretKey: env.STRIPE_SECRET_KEY });
}
