import {
  createCommerceRuntimeService,
  type CommerceRuntimeServiceDeps,
} from "../../../../domains/commerce/commerceRuntimeService.js";
import {
  createSupabaseCommerceOmsPort,
  type CommerceOmsSupabaseClient,
} from "../../../../adapters/supabase/commerceOmsPort.js";
import {
  createManagedCommerceRuntimeOrderPort,
  type ManagedCommerceRuntimeClient,
} from "../../../../adapters/managed/commerce/commerceRuntimePort.js";
import {
  createManagedInventoryReservationPort,
  type ManagedInventoryReservationClient,
} from "../../../../adapters/managed/commerce/inventoryReservationPort.js";
import { readInventoryReservationLegacySchemaFallbackConfig } from "../../../commerce/inventoryReservationRuntimeConfig.js";
import { createSupabaseCheckoutCompensationAdapter } from "../../../../adapters/supabase/commerce/checkoutCompensation.js";
import {
  createManagedPaymentControlRuntimePort,
  type ManagedPaymentControlClient,
} from "../../../../adapters/managed/commerce/paymentControlRuntimePort.js";
import {
  getPaymentExecutionAdapter,
} from "../../../../domains/payment/paymentAdapterRegistry.js";
import { noopSettlementAllowed } from "../../../../_lib/observability/environment.js";
import { buildStripeAdapterIfEnabled } from "../../../../adapters/stripe/stripeAdapterFactory.js";
import { buildTpayAdapterIfEnabled } from "../../../../adapters/tpay/tpayAdapterFactory.js";
import type { PaymentExecutionPort } from "../../../../../src/domains/payment/ports.js";
import { evaluateCommerceFulfillmentCreateReadiness } from "../../../../../src/domains/fulfillment/commerceFulfillmentReadiness.js";
import type { CommerceOmsReadPort } from "../../../../../src/domains/commerce/omsPorts.js";
import type { OmsFulfillmentBlockReason } from "../../../../../src/domains/commerce/types.js";
import type { CommerceRuntimeReadinessPort } from "../../../../../src/domains/commerce/runtimePorts.js";

type RuntimeSupabaseClient = ManagedCommerceRuntimeClient &
  ManagedInventoryReservationClient &
  ManagedPaymentControlClient &
  CommerceOmsSupabaseClient;

type CheckoutCommandComposition = Required<Pick<CommerceRuntimeServiceDeps,
  "persistencePort" | "quotePort" | "orderDraftPort"
>> & Pick<CommerceRuntimeServiceDeps, "resolveExecutionPort" | "now">;

export function createHiddenCommerceRuntimePort(
  serviceClient: unknown,
  command?: CheckoutCommandComposition,
): ReturnType<typeof createCommerceRuntimeService> {
  const client = serviceClient as RuntimeSupabaseClient;
  const omsPort = createSupabaseCommerceOmsPort(client);
  // The reservation port already implements the whole compensation contract, so
  // the command path releases stock through the same writer the saga reserves it
  // with instead of composing a second one.
  const inventoryPort = createManagedInventoryReservationPort(client, {
    legacySchemaFallback: readInventoryReservationLegacySchemaFallbackConfig(),
    compensation: createSupabaseCheckoutCompensationAdapter(client),
  });

  return createCommerceRuntimeService({
    orderPort: createManagedCommerceRuntimeOrderPort(client),
    inventoryPort,
    compensationPort: inventoryPort,
    paymentPort: createManagedPaymentControlRuntimePort(client),
    readinessPort: createCommerceRuntimeReadinessPort(omsPort),
    resolveExecutionPort: command?.resolveExecutionPort ?? buildResolveExecutionPort(),
    ...command,
  });
}

/**
 * Provider-registry resolver factory.
 *
 * - Flag OFF (default): only no-op providers (`hidden_rehearsal`/`noop_payment`)
 *   resolve; a request that explicitly selected a real provider (stripe/tpay)
 *   THROWS (`UnknownPaymentProviderError`) — production posture, fail closed.
 * - Flag ON: registry lookup per request, with env-driven injected adapters from
 *   `buildInjectedAdaptersFromEnv` (W11.7). Stripe and Tpay adapters activate
 *   only when their provider-specific flags and server-only env are present.
 *   Stripe `sk_live_` still requires `STRIPE_LIVE_CONFIRMED=true`; Tpay requires
 *   exactly one explicit pre-prod mode (sandbox, simulator, or verified test).
 *
 * CRITICAL — no silent no-op downgrade for real providers. The old resolver
 * caught every error and returned a no-op adapter, so a checkout that requested
 * `stripe` (because the card tile was offered) but whose Stripe adapter was not
 * wired (flag drift between the checkout gate and the registry env) was served
 * by the rehearsal no-op: the saga minted a `pending_payment` order with NO
 * provider PaymentIntent and NO clientSecret, stranding the buyer on /platnosc
 * forever. We now let `getPaymentExecutionAdapter` throw for an unwired real
 * provider; the saga surfaces it as a fail-closed checkout error (compensating
 * the draft) so the buyer gets a retry instead of an unpayable order.
 */
export function buildResolveExecutionPort(): (providerKind: string) => PaymentExecutionPort {
  const adapters: Record<string, PaymentExecutionPort> = {};
  if (process.env.COMMERCE_V2_W11_PROVIDER_REGISTRY === "true") {
    const stripeAdapter = buildStripeAdapterIfEnabled(process.env);
    if (stripeAdapter) adapters.stripe = stripeAdapter.adapter;
    const tpayAdapter = buildTpayAdapterIfEnabled(process.env);
    if (tpayAdapter) adapters.tpay = tpayAdapter.adapter;
  }
  // Single seam: no-op (rehearsal) providers never settle paid in production.
  const noopAllowed = noopSettlementAllowed(process.env);
  return (providerKind: string) => {
    try {
      return getPaymentExecutionAdapter(providerKind, adapters, noopAllowed);
    } catch (error) {
      // Diagnosable signal for the flag-drift case (Axiom): a real provider was
      // requested but no adapter is wired. Re-throw so checkout fails closed.
      console.error(
        "checkout_payment_provider_unavailable",
        JSON.stringify({
          providerKind,
          wired: Object.keys(adapters),
          registryEnabled: process.env.COMMERCE_V2_W11_PROVIDER_REGISTRY === "true",
        }),
      );
      throw error;
    }
  };
}

function createCommerceRuntimeReadinessPort(
  omsPort: Pick<CommerceOmsReadPort, "getOrderDetail">,
): CommerceRuntimeReadinessPort {
  return {
    async evaluateOrderReadiness(input) {
      const detail = await omsPort.getOrderDetail({ orderId: input.orderId });
      const omsEligibility = normalizeOmsEligibility(detail?.order.fulfillmentEligibility);
      const inventory = detail?.order.inventory;
      const fulfillmentCreate = evaluateCommerceFulfillmentCreateReadiness({
        omsEligibility,
        hasClient: Boolean(detail?.order.clientId),
        hasShippingAddress: detail?.order.fulfillmentEligibility.reason !== "missing_shipping_address",
        orderItemCount: input.fallbackOrderItemCount ?? 1,
        allOrderItemsHaveSku: input.allOrderItemsHaveSku,
        allOrderItemsReserved: inventory?.status === "reserved",
      });

      return {
        omsEligibility,
        fulfillmentCreate,
      };
    },
  };
}

function normalizeOmsEligibility(
  eligibility:
    | { allowed: boolean; reason?: OmsFulfillmentBlockReason | null }
    | undefined,
): { allowed: true; reason: null } | { allowed: false; reason: OmsFulfillmentBlockReason } {
  if (!eligibility) return { allowed: false, reason: "order_not_paid" };
  if (eligibility.allowed) return { allowed: true, reason: null };
  return { allowed: false, reason: eligibility.reason ?? "order_not_paid" };
}
