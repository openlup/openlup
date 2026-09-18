import { buildStripeAdapterIfEnabled } from "../../adapters/stripe/stripeAdapterFactory.js";
import { createStripeApiClient } from "../../infra/stripe/stripeApiClient.js";
import type {
  AutomaticRenewalPaymentRail,
  AutomaticRenewalPaymentRailResolver,
} from "../../domains/subscription/automaticRenewalPorts.js";
import { createPaymentProviderReadbackRegistry } from "../paymentProviderReadbackRegistry.js";

type Env = Record<string, string | undefined>;

/**
 * Composition-only provider map. The persisted settlement-channel key stays
 * opaque; concrete provider names stop here and never enter the public rail.
 */
export function createAutomaticRenewalPaymentRailResolver(
  env: Env,
): AutomaticRenewalPaymentRailResolver {
  const readbacks = createPaymentProviderReadbackRegistry(env);
  const rails = new Map<string, AutomaticRenewalPaymentRail>();
  const stripe = buildStripeAdapterIfEnabled(env);
  if (stripe && readbacks.stripe) {
    const client = createStripeApiClient({ secretKey: env.STRIPE_SECRET_KEY! });
    rails.set("stripe", rail(stripe.adapter, readbacks.stripe, async (settlementIntentId) => {
      const found = await client.searchPaymentIntentsByMetadata({
        key: "paymentIntentId", value: settlementIntentId, limit: 2,
      });
      if (found.ids.length > 1) throw new Error("subscription_renewal_provider_attempt_conflict");
      return found.ids[0] ?? null;
    }));
  }
  return { resolve: (channelKey) => rails.get(channelKey) ?? null };
}

function rail(
  executionPort: AutomaticRenewalPaymentRail["executionPort"],
  readback: ReturnType<typeof createPaymentProviderReadbackRegistry>["stripe"],
  findExternalAttempt: (settlementIntentId: string) => Promise<string | null>,
): AutomaticRenewalPaymentRail {
  if (!readback) throw new Error("subscription_renewal_readback_required");
  return {
    executionPort,
    findExternalAttempt: ({ settlementIntentId }) => findExternalAttempt(settlementIntentId),
    async readOutcome(input) {
      const observed = await readback.readPayment({ providerPaymentId: input.externalAttemptRef });
      return {
        status: observed.status,
        occurredAt: observed.occurredAt,
        reason: observed.failureReason,
        amountMinor: observed.amountMinor,
        currency: observed.currency,
      };
    },
  };
}
