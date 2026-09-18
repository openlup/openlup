// This module is the composition seam for the webhook ports: it already binds
// the concrete Supabase implementations, so it is also where the published
// provider capabilities are bound. The port that BRANCHES on them receives them
// as an argument and names no provider.
import { paymentProviderCapabilityRegistry } from "../../paymentProviderCapabilityRegistry.js";
import type { DataGatewayPort } from "../../../../src/domains/platform-runtime/ports.js";
import type {
  AppliedPaymentResult,
  IngestedPaymentEvent,
  PaymentWebhookPort,
} from "../../../../src/domains/payment/ports.js";
import type {
  NormalizedProviderPaymentWebhook,
  PaymentWebhookAfterProcessed,
  PaymentWebhookControlPort,
  PaymentWebhookMethodRefPort,
} from "../../../domains/payment/paymentWebhookHandlers.js";
import {
  createSupabasePaymentWebhookControlPort,
  createSupabasePaymentWebhookMethodRefPort,
  createSupabasePaymentWebhookPort,
  type PaymentWebhookSupabaseClient,
} from "./paymentWebhook.js";
import {
  deriveSimulatorRecurringActivationAlias,
  tryActivateTpaySubscriptionFromWebhook,
  type TpaySubscriptionActivationClient,
} from "./tpaySubscriptionActivation.js";
import { handoffExplicitPaymentRefusal } from "../../../domains/payment/paymentWebhookPostProcessing.js";

export type PaymentMethodDeliveryConsumer = (
  client: unknown,
  input: NormalizedProviderPaymentWebhook,
) => Promise<void>;

const missingPaymentMethodDeliveryConsumer: PaymentMethodDeliveryConsumer = async () => {
  throw new Error("payment_method_delivery_consumer_unavailable");
};

export function createPaymentWebhookPortViaGateway(gateway: DataGatewayPort): PaymentWebhookPort {
  return {
    ingestEvent(input): Promise<IngestedPaymentEvent> {
      return gateway.asService((client) =>
        createSupabasePaymentWebhookPort(client as PaymentWebhookSupabaseClient).ingestEvent(input),
      );
    },

    applyEventResult(input): Promise<AppliedPaymentResult> {
      return gateway.asService((client) =>
        createSupabasePaymentWebhookPort(client as PaymentWebhookSupabaseClient).applyEventResult(input),
      );
    },
  };
}

export function createPaymentWebhookControlPortViaGateway(
  gateway: DataGatewayPort,
): PaymentWebhookControlPort {
  return {
    ingestPaymentEvent(input) {
      return gateway.asService((client) =>
        createSupabasePaymentWebhookControlPort(client as PaymentWebhookSupabaseClient)
          .ingestPaymentEvent(input),
      );
    },

    applyPaymentResult(input) {
      return gateway.asService((client) => {
        const port = createSupabasePaymentWebhookControlPort(client as PaymentWebhookSupabaseClient);
        if (!port.applyPaymentResult) throw new Error("payment_webhook_apply_result_unavailable");
        return port.applyPaymentResult(input);
      });
    },

    confirmSubscriptionActivation(input) {
      return gateway.asService((client) => {
        const port = createSupabasePaymentWebhookControlPort(client as PaymentWebhookSupabaseClient);
        if (!port.confirmSubscriptionActivation) {
          throw new Error("payment_webhook_subscription_confirmation_unavailable");
        }
        return port.confirmSubscriptionActivation(input);
      });
    },

    recoverPaidSubscriptionActivationWithCard(input) {
      return gateway.asService((client) => {
        const port = createSupabasePaymentWebhookControlPort(client as PaymentWebhookSupabaseClient);
        if (!port.recoverPaidSubscriptionActivationWithCard) {
          throw new Error("payment_webhook_paid_activation_card_recovery_unavailable");
        }
        return port.recoverPaidSubscriptionActivationWithCard(input);
      });
    },

    markSetupEventProcessed(input) {
      return gateway.asService((client) => {
        const port = createSupabasePaymentWebhookControlPort(client as PaymentWebhookSupabaseClient);
        if (!port.markSetupEventProcessed) {
          throw new Error("payment_webhook_mark_setup_event_processed_unavailable");
        }
        return port.markSetupEventProcessed(input);
      });
    },
  };
}

export function createPaymentWebhookMethodRefPortViaGateway(
  gateway: DataGatewayPort,
  consumeMethodDelivery: PaymentMethodDeliveryConsumer = missingPaymentMethodDeliveryConsumer,
): PaymentWebhookMethodRefPort {
  return {
    upsertFromWebhook(input) {
      return gateway.asService(async (client) => {
        const result = await createSupabasePaymentWebhookMethodRefPort(client as PaymentWebhookSupabaseClient, paymentProviderCapabilityRegistry)
          .upsertFromWebhook(input);
        await consumeMethodDelivery(client, input);
        return result;
      });
    },
  };
}

/**
 * Everything this delivery means for the stored method, in the one order that
 * works. Both consumptions resolve against the stored row and only the
 * gateway's client can read a table, so both live at the seam rather than
 * inside the method-ref port. The lifecycle transition runs AFTER the
 * registration upsert: a registration creates the row it addresses, and a death
 * signal carries no reusable method, so the upsert is a no-op on exactly the
 * deliveries it acts on.
 *
 * The retry consumption runs after BOTH, which is what lets one call serve a
 * registration and a rotation alike — and what makes a death unreachable from
 * it, since the transition has already deactivated the row it reads.
 */
export function createTpayPaymentWebhookMethodRefPortViaGateway(
  gateway: DataGatewayPort,
  consumeMethodDelivery: PaymentMethodDeliveryConsumer = missingPaymentMethodDeliveryConsumer,
): PaymentWebhookMethodRefPort {
  return {
    upsertFromWebhook(event) {
      return gateway.asService(async (client) => {
        const basePort = createSupabasePaymentWebhookMethodRefPort(client as PaymentWebhookSupabaseClient, paymentProviderCapabilityRegistry);
        const result = await upsertAliasMethodRef(client, basePort, event);
        await consumeMethodDelivery(client, event);
        return result;
      });
    },
  };
}

async function upsertAliasMethodRef(
  client: unknown,
  basePort: PaymentWebhookMethodRefPort,
  event: NormalizedProviderPaymentWebhook,
): Promise<{ replayed: boolean }> {
  if (event.reusableMethod) return basePort.upsertFromWebhook(event);
  if (!isTpaySubscriptionActivationClient(client)) return { replayed: false };
  const reusableMethod = await resolveAliasReusableMethodFromPaymentIntent(client, event);
  if (!reusableMethod) return { replayed: false };
  return basePort.upsertFromWebhook({ ...event, reusableMethod });
}

export function createTpayActivationAfterProcessedViaGateway(
  gateway: DataGatewayPort,
): PaymentWebhookAfterProcessed {
  return async (input) => {
    await gateway.asService(async (client) => {
      if (!isTpaySubscriptionActivationClient(client)) return;
      await tryActivateTpaySubscriptionFromWebhook(client, input);
    });
  };
}

export function createSubscriptionWebhookDunningAfterProcessedViaGateway(
  gateway: DataGatewayPort,
): PaymentWebhookAfterProcessed {
  return async ({ event, ingested, resultStatus }) => {
    await handoffExplicitPaymentRefusal({
      outcome: resultStatus === "failed" ? "refused" : "not_refused",
      idempotencyKey: `provider-webhook:${event.provider}:${event.providerEventId}:dunning`,
      paymentIntentId: ingested.paymentIntentId,
      sourceEventId: event.providerEventId,
      failureReason: readFailureReason(event.rawPayload),
      occurredAt: event.occurredAt,
    }, {
      openFromExplicitRefusal: (input) => gateway.asService(async (client) => {
        const rpc = (client as { rpc?: unknown }).rpc;
        if (typeof rpc !== "function") return;
        const result = await rpc.call(client, "subscription_open_dunning_from_failed_payment_result", {
          p_idempotency_key: input.idempotencyKey,
          p_payment_intent_id: input.paymentIntentId,
          p_provider_event_id: input.sourceEventId,
          p_failure_reason: input.failureReason,
          p_occurred_at: input.occurredAt,
        });
        if (result?.error) {
          const error = result.error;
          throw error instanceof Error
            ? error
            : new Error(`subscription_webhook_dunning_failed: ${String(error.message ?? error.code ?? "unknown")}`);
        }
      }),
    });
  };
}

export function deriveSimulatorRecurringActivationAliasViaGateway(
  gateway: DataGatewayPort,
  paymentIntentId: string,
): Promise<{ clientId: string; subscriptionId: string; providerMethodRef: string } | null> {
  return gateway.asService((client) => {
    if (!isTpaySubscriptionActivationClient(client)) return Promise.resolve(null);
    return deriveSimulatorRecurringActivationAlias(client, paymentIntentId);
  });
}

function isTpaySubscriptionActivationClient(client: unknown): client is TpaySubscriptionActivationClient {
  return !!client &&
    typeof (client as { rpc?: unknown }).rpc === "function" &&
    typeof (client as { from?: unknown }).from === "function";
}

async function resolveAliasReusableMethodFromPaymentIntent(
  client: TpaySubscriptionActivationClient,
  event: NormalizedProviderPaymentWebhook,
): Promise<NonNullable<NormalizedProviderPaymentWebhook["reusableMethod"]> | null> {
  if (event.provider !== "tpay") return null;
  if (event.rawPayload.eventKind !== "blik_alias") return null;
  if (event.eventType !== "setup.succeeded") return null;
  if (!event.paymentIntentId) return null;

  const ownership = await readPaymentIntentOrderOwnership(client, event.paymentIntentId);
  if (!ownership) return null;

  return {
    clientId: ownership.clientId,
    subscriptionId: ownership.subscriptionId,
    providerCustomerRef: null,
    providerMethodRef: event.providerPaymentId,
    providerMandateRef: null,
    methodKind: "blik_payid",
    status: "active",
    consentSnapshot: {
      source: "tpay.alias.webhook",
      event: event.rawPayload.event ?? "ALIAS_REGISTER",
      resolvedBy: "payment_intent",
    },
  };
}

async function readPaymentIntentOrderOwnership(
  client: TpaySubscriptionActivationClient,
  paymentIntentId: string,
): Promise<{ clientId: string; subscriptionId: string | null } | null> {
  const intent = await maybeSingle(client.from("commerce_payment_intents")
    .select("id,order_id,subscription_id")
    .eq("id", paymentIntentId));
  if (!intent) return null;

  const order = await maybeSingle(client.from("commerce_orders")
    .select("id,client_id,subscription_id")
    .eq("id", readString(intent, "order_id")));
  if (!order) return null;

  const clientId = readNullableString(order, "client_id");
  if (!clientId) return null;
  return {
    clientId,
    subscriptionId: readNullableString(intent, "subscription_id") ?? readNullableString(order, "subscription_id"),
  };
}

async function maybeSingle(builder: {
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown | null }>;
}): Promise<Record<string, unknown> | null> {
  const { data, error } = await builder.maybeSingle();
  if (error) throw error instanceof Error ? error : new Error("tpay_webhook_lookup_failed");
  return data && typeof data === "object" ? data as Record<string, unknown> : null;
}

function readString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.length === 0) throw new Error("tpay_webhook_lookup_invalid");
  return raw;
}

function readNullableString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function readFailureReason(rawPayload: Record<string, unknown>): string | null {
  for (const key of ["failureReason", "failure_reason", "decline_code", "status_description"]) {
    const value = rawPayload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}
