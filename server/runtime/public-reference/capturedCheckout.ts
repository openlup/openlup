import type { DataGatewayPort } from "../../../src/domains/platform-runtime/ports.js";
import type { CheckoutCommandV1 } from "../../../src/domains/commerce/checkoutCommandContracts.js";
import { CommerceRuntimeConflictError, type CheckoutCommandRuntimeResult } from "../../../src/domains/commerce/runtimePorts.js";
import type { ApplyHiddenCheckoutPaymentResultRequest, ApplyHiddenCheckoutPaymentResultResponse } from "../../../src/domains/commerce/runtimeContracts.js";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import { sendBffError } from "../../_lib/bff/response.js";
import { checkAndRecordCheckoutAttempt, extractClientIp, type PublicCheckoutRateLimitClient } from "../../_lib/rate-limit/publicCheckoutRateLimit.js";
import { checkoutRiskBlockingEnabled, riskHashSecret } from "../../_lib/config/featureFlags.js";
import { riskSubjectHash } from "../../domains/risk/riskFingerprint.js";
import { createReferenceCheckoutHandler } from "../../domains/commerce/referenceCheckoutHandler.js";
import {
  createLocalReferenceCheckoutRuntimePort,
  createLocalReferenceRiskCheckoutBlocklistPort,
  localReferenceCommandMatchesProfile,
  readLocalReferencePaymentOutcome,
  LOCAL_REFERENCE_SUBSCRIPTION_PAYMENT_PROVIDER,
} from "../../adapters/localReferenceStoreAdapter.js";
import {
  createPaymentWebhookControlPortViaGateway,
  createPaymentWebhookMethodRefPortViaGateway,
} from "../../adapters/supabase/payment/paymentWebhookGateway.js";
import { consumeSupabasePaymentMethodDelivery } from "../../adapters/supabase/payment/paymentMethodLifecycle.js";
import { createSupabaseConfiguratorIntentPersistencePort } from "../../adapters/supabase/configuratorIntentPersistence.js";
import type { NormalizedProviderPaymentWebhook } from "../../domains/payment/paymentWebhookHandlers.js";

type Outcome = "captured" | "refused";
const preparedKey = (command: CheckoutCommandV1) => `${command.idempotencyKey}:payment-execution:prepare-attempt`;
type Row = Record<string, unknown>;
type ReadQuery = { eq(column: string, value: string): ReadQuery; single(): PromiseLike<{ data: unknown; error: unknown }> };
type ReadClient = { from(table: string): { select(columns: string): ReadQuery } };
type OutcomeReadClient = { from(table: string): {
  select(columns: string): { eq(column: string, value: string): { limit(count: number): PromiseLike<{ data: unknown; error: unknown }> } };
} };

function row(value: unknown, label: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}_invalid`);
  return value as Row;
}

async function readById(client: ReadClient, table: string, columns: string, id: string): Promise<Row> {
  return readBy(client, table, columns, "id", id);
}

async function readBy(client: ReadClient, table: string, columns: string, column: string, value: string): Promise<Row> {
  const { data, error } = await client.from(table).select(columns).eq(column, value).single();
  if (error || !data) throw new Error(`${table}_read_failed`);
  return row(data, table);
}

/** A changed operator setting cannot rewrite an already-issued payment attempt. */
export async function assertNoRecordedOutcomeChange(
  gateway: DataGatewayPort,
  command: CheckoutCommandV1,
  configuredOutcome: Outcome,
): Promise<boolean> {
  return gateway.asService(async (service) => {
    const client = service as OutcomeReadClient;
    const { data, error } = await client.from("commerce_payment_attempts")
      .select("provider,request_payload,response_payload,idempotency_key")
      .eq("idempotency_key", preparedKey(command)).limit(2);
    if (error || !Array.isArray(data) || data.length > 1) throw new Error("reference_recorded_outcome_read_failed");
    if (data.length === 0) return false;
    const attempt = row(data[0], "reference_recorded_attempt");
    const request = row(attempt.request_payload, "reference_recorded_request");
    const payload = row(attempt.response_payload, "reference_recorded_response");
    if (attempt.provider !== LOCAL_REFERENCE_SUBSCRIPTION_PAYMENT_PROVIDER ||
      request.source !== "reference_store.local.payment_simulator.v1" ||
      request.runtimeIdempotencyKey !== command.idempotencyKey ||
      (payload.outcome !== "captured" && payload.outcome !== "refused")) {
      throw new Error("reference_recorded_outcome_invalid");
    }
    if (payload.outcome !== configuredOutcome) {
      throw new CommerceRuntimeConflictError("Reference payment outcome differs from the recorded attempt");
    }
    return true;
  });
}

/** A prepared provider attempt cannot be redispatched on replay. Revalidate
 * the original command fingerprint in its canonical persistence RPC, then
 * resume only the completed simulator attempt and finalized order receipts. */
export async function resumeRecordedCheckout(
  gateway: DataGatewayPort,
  command: CheckoutCommandV1,
): Promise<CheckoutCommandRuntimeResult> {
  return gateway.asService(async (service) => {
    const client = service as ReadClient;
    const persistence = await createSupabaseConfiguratorIntentPersistencePort(service as never).persistCheckoutCommand(command);
    if (!persistence.replayed) throw new Error("reference_command_not_replayed");
    const finalizedReceipt = await client.from("commerce_idempotency_keys").select("status,response_payload")
      .eq("scope", "commerce.checkout_order_finalize").eq("idempotency_key", command.idempotencyKey).single();
    const draftReceipt = await client.from("commerce_idempotency_keys").select("status,response_payload")
      .eq("scope", "commerce.order_draft.create").eq("idempotency_key", command.idempotencyKey).single();
    if (finalizedReceipt.error || draftReceipt.error) throw new Error("reference_order_receipt_read_failed");
    const finalized = row(finalizedReceipt.data, "reference_finalize_receipt");
    const draft = row(draftReceipt.data, "reference_draft_receipt");
    const order = row(row(finalized.response_payload, "reference_finalize_payload").finalizedOrder, "reference_finalized_order");
    const orderDraft = row(row(draft.response_payload, "reference_draft_payload").orderDraft, "reference_order_draft");
    const total = row(order.total, "reference_order_total");
    if (finalized.status !== "completed" || draft.status !== "completed" ||
      order.mode !== "subscription_cycle" || order.clientId !== persistence.clientId ||
      typeof order.orderId !== "string" || total.currency !== command.currency ||
      typeof total.amountMinor !== "number" || !orderDraft.quoteSnapshot) {
      throw new Error("reference_order_receipt_mismatch");
    }
    const attempt = await readBy(client, "commerce_payment_attempts", "id,payment_intent_id,status", "idempotency_key", preparedKey(command));
    const intent = await readById(client, "commerce_payment_intents", "id,order_id,active_attempt_id,status", String(attempt.payment_intent_id));
    if (intent.order_id !== order.orderId || intent.active_attempt_id !== attempt.id) {
      throw new Error("reference_resumed_attempt_mismatch");
    }
    // Only these persisted fields are consumed by the existing public response
    // handler; the settlement path below validates the full payment evidence.
    return {
      quoteSnapshot: orderDraft.quoteSnapshot, persistence, orderDraft,
      runtime: { runtime: {
        orderId: order.orderId, clientId: order.clientId, total, finalizedReplayed: true,
        payment: { paymentIntentId: intent.id, paymentAttemptId: attempt.id,
          status: intent.status, attemptStatus: attempt.status },
      } },
      settlement: null,
    } as CheckoutCommandRuntimeResult;
  });
}

/** Read durable server-issued facts before treating a local simulator marker as payment truth. */
export async function readCapturedCheckoutEvidence(
  gateway: DataGatewayPort,
  command: CheckoutCommandV1,
  result: CheckoutCommandRuntimeResult,
): Promise<{ outcome: Outcome; intentId: string; attemptId: string; paymentId: string; subscriptionId: string; amountMinor: number; currency: string; occurredAt: string }> {
  const runtime = result.runtime.runtime;
  const attemptId = runtime.payment.paymentAttemptId;
  if (!attemptId) throw new Error("reference_payment_attempt_missing");
  return gateway.asService(async (service) => {
    const client = service as ReadClient;
    const attempt = await readById(client, "commerce_payment_attempts", "id,payment_intent_id,payment_id,provider,idempotency_key,status,amount_cents,currency,request_payload,response_payload,created_at", attemptId);
    const intent = await readById(client, "commerce_payment_intents", "id,order_id,subscription_id,target_kind,payment_id,active_attempt_id,amount_cents,currency", runtime.payment.paymentIntentId);
    const response = row(attempt.response_payload, "reference_payment_response");
    const request = row(attempt.request_payload, "reference_payment_request");
    const outcome = response.outcome;
    if ((outcome !== "captured" && outcome !== "refused") ||
      request.source !== "reference_store.local.payment_simulator.v1" ||
      attempt.payment_intent_id !== intent.id || attempt.payment_id !== intent.payment_id ||
      attempt.id !== intent.active_attempt_id || attempt.provider !== LOCAL_REFERENCE_SUBSCRIPTION_PAYMENT_PROVIDER ||
      attempt.idempotency_key !== preparedKey(command) ||
      request.runtimeIdempotencyKey !== command.idempotencyKey ||
      intent.order_id !== runtime.orderId || intent.target_kind !== "subscription_cycle" ||
      typeof intent.subscription_id !== "string" ||
      attempt.amount_cents !== runtime.total.amountMinor || intent.amount_cents !== runtime.total.amountMinor ||
      attempt.currency !== runtime.total.currency || intent.currency !== runtime.total.currency ||
      typeof attempt.created_at !== "string" || Number.isNaN(Date.parse(attempt.created_at))) {
      throw new Error("reference_payment_evidence_mismatch");
    }
    return {
      outcome, intentId: String(intent.id), attemptId, paymentId: String(intent.payment_id),
      subscriptionId: intent.subscription_id, amountMinor: runtime.total.amountMinor,
      currency: runtime.total.currency, occurredAt: attempt.created_at,
    };
  });
}

export async function settleCapturedCheckout(
  gateway: DataGatewayPort,
  command: CheckoutCommandV1,
  result: CheckoutCommandRuntimeResult,
  applyPaymentResult: (input: ApplyHiddenCheckoutPaymentResultRequest) => Promise<ApplyHiddenCheckoutPaymentResultResponse>,
): Promise<CheckoutCommandRuntimeResult> {
  const evidence = await readCapturedCheckoutEvidence(gateway, command, result);
  // Refusals are already closed by commerceRuntimeStartResponse through its
  // existing provider-decline path. Never turn a persisted refusal into success.
  if (evidence.outcome === "refused") {
    if (result.runtime.runtime.payment.status !== "failed") throw new Error("reference_refusal_not_closed");
    return result;
  }
  const methodRef = `pm_openlup_reference_${evidence.attemptId.replaceAll("-", "")}`;
  const event: NormalizedProviderPaymentWebhook = {
    provider: "stripe",
    providerEventId: `openlup-reference:${evidence.attemptId}:captured`,
    eventType: "payment.succeeded",
    providerPaymentId: `openlup-reference:${evidence.attemptId}`,
    paymentIntentId: evidence.intentId,
    paymentAttemptId: evidence.attemptId,
    amountMinor: evidence.amountMinor,
    currency: evidence.currency,
    occurredAt: evidence.occurredAt,
    rawPayload: { source: "public-reference.no-egress.v1", paymentAttemptId: evidence.attemptId },
    reusableMethod: {
      clientId: result.runtime.runtime.clientId,
      subscriptionId: evidence.subscriptionId,
      providerCustomerRef: `cus_openlup_reference_${result.runtime.runtime.clientId.replaceAll("-", "")}`,
      providerMethodRef: methodRef,
      methodKind: "card",
      status: "active",
      consentSnapshot: { source: "public-reference.no-egress.v1" },
    },
  };
  const control = createPaymentWebhookControlPortViaGateway(gateway);
  const ingested = await control.ingestPaymentEvent(event);
  if (ingested.paymentIntentId !== evidence.intentId || ingested.paymentAttemptId !== evidence.attemptId) {
    throw new Error("reference_payment_event_mismatch");
  }
  const settlement = await applyPaymentResult({
    idempotencyKey: `openlup-reference:${evidence.attemptId}:apply`,
    orderId: result.runtime.runtime.orderId,
    paymentIntentId: evidence.intentId,
    paymentEventId: ingested.paymentEventId,
    resultStatus: "succeeded",
    occurredAt: event.occurredAt,
    failureReason: null,
  });
  if (settlement.paymentResult.paymentIntentId !== evidence.intentId ||
    settlement.paymentResult.paymentAttemptId !== evidence.attemptId ||
    settlement.paymentResult.orderId !== result.runtime.runtime.orderId ||
    settlement.paymentResult.status !== "succeeded") {
    throw new Error("reference_payment_result_mismatch");
  }
  await createPaymentWebhookMethodRefPortViaGateway(gateway, consumeSupabasePaymentMethodDelivery).upsertFromWebhook(event);
  if (!control.confirmSubscriptionActivation) throw new Error("reference_subscription_confirmation_unavailable");
  const confirmed = await control.confirmSubscriptionActivation({
    idempotencyKey: `openlup-reference:${evidence.attemptId}:activate`,
    paymentIntentId: evidence.intentId,
    occurredAt: event.occurredAt,
    methodRef,
    methodKind: "card",
  });
  if (!confirmed.confirmed || confirmed.status !== "active") throw new Error("reference_subscription_not_active");
  return {
    ...result,
    settlement: { ...settlement, paymentResult: {
      ...settlement.paymentResult,
      replayed: ingested.replayed || settlement.paymentResult.replayed,
    } },
  };
}

/** Mounted only after the server-selected disposable profile has been proven. */
export function createCapturedReferenceCheckoutHandler(input: {
  gateway: DataGatewayPort;
  outcome: Outcome;
  assertDisposable: () => Promise<void>;
}) {
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    try {
      await input.assertDisposable();
      if (readLocalReferencePaymentOutcome() !== input.outcome) throw new Error("reference_outcome_configuration_changed");
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Reference checkout is unavailable");
      return;
    }
    return input.gateway.asService((client) => {
      const runtime = createLocalReferenceCheckoutRuntimePort(client);
      return createReferenceCheckoutHandler({
        startCheckout: async (command) => {
          const recorded = await assertNoRecordedOutcomeChange(input.gateway, command, input.outcome);
          const started = recorded ? await resumeRecordedCheckout(input.gateway, command) : await runtime.startCheckoutCommand({
            command,
            paymentProvider: LOCAL_REFERENCE_SUBSCRIPTION_PAYMENT_PROVIDER,
            metadata: { source: "public-reference.no-egress.v1" },
          });
          return settleCapturedCheckout(input.gateway, command, started, (request) => runtime.applyPaymentResult(request));
        },
        checkRateLimit: (request, command) => checkAndRecordCheckoutAttempt({
          client: client as PublicCheckoutRateLimitClient,
          ip: extractClientIp(request.headers),
          email: command.customer.email,
          journeyIdempotencyKey: command.idempotencyKey,
          paymentAttemptSequence: 0,
        }),
        checkRiskBlocklist: checkoutRiskBlockingEnabled()
          ? async (request, command) => createLocalReferenceRiskCheckoutBlocklistPort(client).checkExactBlocklist({
            subjectRefs: [
              { subjectKind: "email", subjectHash: riskSubjectHash("email", command.customer.email, riskHashSecret()) },
              { subjectKind: "ip", subjectHash: riskSubjectHash("ip", extractClientIp(request.headers), riskHashSecret()) },
            ],
          })
          : undefined,
        admitProfile: (command) => command.mode === "subscription" && localReferenceCommandMatchesProfile(command),
      })(req, res);
    });
  };
}
