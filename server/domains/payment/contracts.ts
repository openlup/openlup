/**
 * The payment domain's public cross-domain surface (server side).
 *
 * Sibling domains import from THIS module, never from the domain's internal
 * files — the architecture guardrail allowlists only the `contracts` /
 * `ports` / `types` segments across domain boundaries. Keep this file a
 * re-publication seam: no logic, no state, one published name per line.
 * (Spelled as `export const` rather than `export ... from` so the module
 * carries executable lines the runtime-coverage gate can observe.)
 */

import {
  METHOD_LAST_DIGITS_SNAPSHOT_KEY as internalMethodLastDigitsKey,
  METHOD_SCHEME_SNAPSHOT_KEY as internalMethodSchemeKey,
} from "./paymentMethodLifecycle.js";
import type { CheckoutActivePaymentActionResolver as InternalActiveActionResolver } from "./checkoutActivePaymentActionResolver.js";
import type { ProviderRecoveryAction as InternalRecoveryAction } from "./checkoutRecoveryPaymentResolver.js";

export const METHOD_SCHEME_SNAPSHOT_KEY = internalMethodSchemeKey;
export const METHOD_LAST_DIGITS_SNAPSHOT_KEY = internalMethodLastDigitsKey;
export type CheckoutActivePaymentActionResolver = InternalActiveActionResolver;
export type ProviderRecoveryAction = InternalRecoveryAction;
