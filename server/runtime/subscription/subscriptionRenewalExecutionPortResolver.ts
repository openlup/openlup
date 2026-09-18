import { buildStripeAdapterIfEnabled } from "../../adapters/stripe/stripeAdapterFactory.js";
import { buildTpayAdapterIfEnabled } from "../../adapters/tpay/tpayAdapterFactory.js";
import type { PaymentProviderCapabilityRegistry } from "@openlup/core/payment";
import type { DueSubscription } from "../../domains/subscription/chargeSubscriptionCycleOffSession.js";
import type { PaymentExecutionPort } from "../../../src/domains/payment/ports.js";
import type { SubscriptionPaymentMethodPreflightReason } from "../../../src/domains/subscription/paymentMethodLifecycle.js";

type Env = Record<string, string | undefined>;

export type SubscriptionRenewalExecutionPortResolution =
  | { port: PaymentExecutionPort; reason: null }
  | { port: null; reason: SubscriptionPaymentMethodPreflightReason };

interface RenewalAdapterFactory {
  build: (env: Env) => { adapter: PaymentExecutionPort } | null;
  /** Persisted preflight reason when this rail's adapter is not configured. */
  notConfiguredReason: SubscriptionPaymentMethodPreflightReason;
}

// The one table that must name a payment provider: turning a kind into the
// factory that constructs its adapter from environment is not a capability, it
// is composition. Every RULE below is read from the capability registry.
const RENEWAL_ADAPTER_FACTORIES: ReadonlyMap<string, RenewalAdapterFactory> = new Map([
  ["stripe", { build: buildStripeAdapterIfEnabled, notConfiguredReason: "stripe_provider_not_configured" }],
  ["tpay", { build: buildTpayAdapterIfEnabled, notConfiguredReason: "tpay_provider_not_configured" }],
] as const satisfies ReadonlyArray<readonly [string, RenewalAdapterFactory]>);

/**
 * Returns provider resolutions scoped to exactly one cron invocation. A null
 * adapter result is deliberately cached too, so one disabled PSP cannot cause
 * repeated factory/config probes for every due subscription.
 *
 * A kind the registry does not publish, or publishes without a local factory,
 * resolves to the same unsupported-provider block as before: fail closed.
 */
export function createSubscriptionRenewalExecutionPortResolver(
  env: Env,
  capabilities: PaymentProviderCapabilityRegistry,
): (due: DueSubscription) => SubscriptionRenewalExecutionPortResolution {
  const resolutions = new Map<string, SubscriptionRenewalExecutionPortResolution>();

  return (due) => {
    const capability = capabilities.get(due.providerKind);
    const factory = capability ? RENEWAL_ADAPTER_FACTORIES.get(capability.providerKind) : undefined;
    if (!capability || !factory) return { port: null, reason: "subscription_provider_not_supported" };

    // Preserve the existing preflight precedence and avoid initializing an
    // adapter for a row that cannot use its rail. The reason string still spells
    // the mandate rail's name because it is persisted and matched downstream.
    const requiredMethodKind = capability.methodHealth.requiredMethodKind;
    if (requiredMethodKind && due.methodKind !== requiredMethodKind) {
      return { port: null, reason: "tpay_recurring_requires_blik_payid" };
    }

    let resolution = resolutions.get(capability.providerKind);
    if (!resolution) {
      const built = factory.build(env);
      resolution = built
        ? { port: built.adapter, reason: null }
        : { port: null, reason: factory.notConfiguredReason };
      resolutions.set(capability.providerKind, resolution);
    }
    return resolution;
  };
}
