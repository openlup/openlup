import {
  createPaymentWebhookMethodRefPortViaGateway,
  createPaymentWebhookPortViaGateway,
  createSubscriptionWebhookDunningAfterProcessedViaGateway,
  createTpayActivationAfterProcessedViaGateway,
  deriveSimulatorRecurringActivationAliasViaGateway, type PaymentMethodDeliveryConsumer,
} from "./paymentWebhookGateway.js";
import type { NormalizedProviderPaymentWebhook } from "../../../domains/payment/paymentWebhookHandlers.js";
import type { CanonicalPaymentEvent } from "../../../../src/domains/payment/types.js";
import type { DataGatewayPort } from "../../../../src/domains/platform-runtime/ports.js";
export type SimulatorResultStatus = "succeeded" | "failed" | "expired";
export type SimulatorAliasResult = "accepted" | "rejected";

export interface StuckRecurringAttempt {
  providerPaymentId: string;
  amountMinor: number | null;
}

interface SelectQueryResult { data: Array<Record<string, unknown>> | null; error: { message?: string } | null; }
interface SelectQueryBuilder extends PromiseLike<SelectQueryResult> {
  select(columns: string): SelectQueryBuilder;
  eq(column: string, value: unknown): SelectQueryBuilder;
  in(column: string, values: readonly unknown[]): SelectQueryBuilder;
  like(column: string, pattern: string): SelectQueryBuilder;
  limit(count: number): SelectQueryBuilder;
}
interface SweepSupabaseClient { from(table: string): SelectQueryBuilder; }

const MAX_PER_SWEEP = 200;
export async function readStuckRecurringAttempts(gateway: DataGatewayPort): Promise<StuckRecurringAttempt[]> {
  return gateway.asService(async (client) => {
    const db = client as SweepSupabaseClient;
    const { data, error } = await db
      .from("commerce_payment_attempts")
      .select("provider_attempt_id, amount_cents, payment_intent_id")
      .eq("provider", "tpay")
      .eq("status", "processing")
      .like("provider_attempt_id", "tpay_sim_%")
      .eq("request_payload->>providerFlow", "recurring_charge")
      .eq("request_payload->>source", "subscription.renewal.cron.v0")
      .limit(MAX_PER_SWEEP);
    if (error) throw new Error(error.message ?? "stuck_recurring_attempt_read_failed");
    const rows = data ?? [];
    const intentIds = [...new Set(rows.map((r) => r.payment_intent_id).filter((x): x is string => typeof x === "string"))];
    if (intentIds.length === 0) return [];

    // Skip attempts whose intent already settled through a sibling or earlier run.
    const { data: intentData, error: intentError } = await db
      .from("commerce_payment_intents")
      .select("id")
      .in("id", intentIds)
      .eq("status", "processing");
    if (intentError) throw new Error(intentError.message ?? "stuck_recurring_intent_read_failed");
    const openIntents = new Set((intentData ?? []).map((r) => String(r.id)));

    return rows
      .filter((r) => typeof r.payment_intent_id === "string" && openIntents.has(r.payment_intent_id))
      .map((row) => ({
        providerPaymentId: String(row.provider_attempt_id),
        amountMinor: typeof row.amount_cents === "number" ? row.amount_cents : null,
      }));
  });
}

export interface ParsedSimulatorRequest {
  providerPaymentId: string;
  resultStatus: SimulatorResultStatus;
  amountMinor: number | null;
  aliasResult: SimulatorAliasResult | null;
  clientId: string | null;
  subscriptionId: string | null;
  providerMethodRef: string | null;
}

type SimulatorAliasInput = Pick<ParsedSimulatorRequest, "clientId" | "subscriptionId" | "providerMethodRef"> & {
  aliasResult: SimulatorAliasResult;
};

export type SimulatorSettlementOutcome =
  | { matched: false }
  | {
      matched: true;
      paymentIntentId: string;
      paymentEventId: string;
      resultStatus: SimulatorResultStatus;
      aliasResult: SimulatorAliasResult | null;
      methodRefReplayed: boolean | null;
      replayed: boolean;
    };

// A genuine idempotency conflict (same key, drifted fingerprint) is a terminal 409, never
// a 5xx the caller retries forever. Mirrors the production handler's 23505 mapping.
export const IDEMPOTENCY_CONFLICT =
  /payment_control_result_idempotency_conflict|payment_method_ref_idempotency_conflict|commerce_idempotency_conflict|\b23505\b/;

async function readCanonicalAppliedResultOccurredAt(
  gateway: DataGatewayPort,
  paymentIntentId: string,
  applyIdempotencyKey: string,
): Promise<string> {
  return gateway.asService(async (client) => {
    const db = client as SweepSupabaseClient;
    const { data, error } = await db
      .from("commerce_payment_state_transitions")
      .select("occurred_at")
      .eq("payment_intent_id", paymentIntentId)
      .eq("idempotency_key", `${applyIdempotencyKey}:payment_result`)
      .eq("transition_kind", "business_result")
      .limit(2);
    if (error) throw new Error(`canonical_payment_result_transition_read_failed: ${error.message ?? "unknown"}`);
    const rows = data ?? [];
    if (rows.length !== 1) throw new Error(rows.length === 0
      ? "canonical_payment_result_transition_missing" : "canonical_payment_result_transition_ambiguous");
    const occurredAt = rows[0]?.occurred_at;
    if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) {
      throw new Error("canonical_payment_result_transition_invalid_occurred_at");
    }
    return occurredAt;
  });
}

// Shared terminal settlement for on-session callbacks and recurring simulator sweeps.
export async function settleSimulatorTransaction(
  gateway: DataGatewayPort,
  parsed: ParsedSimulatorRequest,
  consumeMethodDelivery?: PaymentMethodDeliveryConsumer,
): Promise<SimulatorSettlementOutcome> {
  const port = createPaymentWebhookPortViaGateway(gateway);
  const event = simulatorEvent(parsed);
  const ingested = await port.ingestEvent({
    event,
    signatureVerified: true,
    rawPayload: event.raw_payload,
  });
  if (!ingested.paymentIntentId) return { matched: false };
  const providerWebhookEvent = simulatorProviderWebhookEvent(parsed, ingested.paymentIntentId);
  const resultStatus = parsed.resultStatus === "succeeded" ? "succeeded" : "failed";
  const applyIdempotencyKey = `tpay-simulator:${parsed.providerPaymentId}:${parsed.resultStatus}:apply`;

  // Re-delivery conflicts are benign only after durable result evidence is read below.
  let applied: { replayed: boolean };
  try {
    applied = await port.applyEventResult({
      idempotencyKey: applyIdempotencyKey,
      paymentIntentId: ingested.paymentIntentId,
      paymentEventId: ingested.paymentEventId,
      resultStatus: parsed.resultStatus,
      occurredAt: providerWebhookEvent.occurredAt,
      failureReason: parsed.resultStatus === "succeeded" ? null : `simulator_${parsed.resultStatus}`,
    });
  } catch (error) {
    if (!IDEMPOTENCY_CONFLICT.test(error instanceof Error ? error.message : String(error))) throw error;
    applied = { replayed: true };
  }
  const dunningEvent = resultStatus === "failed"
    ? {
        ...providerWebhookEvent,
        occurredAt: await readCanonicalAppliedResultOccurredAt(
          gateway,
          ingested.paymentIntentId,
          applyIdempotencyKey,
        ),
      }
    : null;

  // First-cycle success may derive a PAYID alias; an existing renewal alias is a no-op.
  let aliasInput: SimulatorAliasInput | null = parsed.aliasResult
    ? {
        aliasResult: parsed.aliasResult,
        clientId: parsed.clientId,
        subscriptionId: parsed.subscriptionId,
        providerMethodRef: parsed.providerMethodRef,
      }
    : null;
  if (!aliasInput && parsed.resultStatus === "succeeded") {
    const auto = await deriveSimulatorRecurringActivationAliasViaGateway(gateway, ingested.paymentIntentId);
    if (auto) {
      aliasInput = {
        aliasResult: "accepted",
        clientId: auto.clientId,
        subscriptionId: auto.subscriptionId,
        providerMethodRef: auto.providerMethodRef,
      };
    }
  }

  const aliasEvent = aliasInput
    ? simulatorMethodRefEvent({ providerPaymentId: parsed.providerPaymentId, ...aliasInput }, ingested.paymentIntentId)
    : null;
  const methodRef = aliasEvent
    ? await createPaymentWebhookMethodRefPortViaGateway(gateway, consumeMethodDelivery).upsertFromWebhook(aliasEvent)
    : null;
  await createTpayActivationAfterProcessedViaGateway(gateway)({
    event: aliasEvent ?? providerWebhookEvent,
    ingested,
    resultStatus,
  });
  if (dunningEvent) {
    await createSubscriptionWebhookDunningAfterProcessedViaGateway(gateway)({
      event: dunningEvent,
      ingested,
      resultStatus,
    });
  }

  return {
    matched: true,
    paymentIntentId: ingested.paymentIntentId,
    paymentEventId: ingested.paymentEventId,
    resultStatus: parsed.resultStatus,
    aliasResult: aliasInput?.aliasResult ?? null,
    methodRefReplayed: methodRef?.replayed ?? null,
    replayed: ingested.replayed || applied.replayed,
  };
}

export function simulatorEvent(input: {
  providerPaymentId: string;
  resultStatus: SimulatorResultStatus;
  amountMinor: number | null;
}): CanonicalPaymentEvent {
  return {
    provider_event_id: `sim:${input.providerPaymentId}:${input.resultStatus}`,
    event_type: input.resultStatus === "succeeded" ? "payment.succeeded" : "payment.failed",
    payment_provider_id: input.providerPaymentId,
    ...(input.amountMinor !== null ? { amount_minor: input.amountMinor } : {}),
    raw_payload: {
      provider: "tpay",
      simulator: true,
      eventKind: "transaction",
      providerPaymentId: input.providerPaymentId,
      resultStatus: input.resultStatus,
    },
  };
}

function simulatorProviderWebhookEvent(input: {
  providerPaymentId: string;
  resultStatus: SimulatorResultStatus;
  amountMinor: number | null;
}, paymentIntentId: string): NormalizedProviderPaymentWebhook {
  return {
    provider: "tpay",
    providerEventId: `sim:${input.providerPaymentId}:${input.resultStatus}`,
    eventType: input.resultStatus === "succeeded" ? "payment.succeeded" : "payment.failed",
    providerPaymentId: input.providerPaymentId,
    paymentIntentId,
    amountMinor: input.amountMinor,
    occurredAt: new Date().toISOString(),
    rawPayload: {
      provider: "tpay",
      simulator: true,
      eventKind: "transaction",
      providerPaymentId: input.providerPaymentId,
      resultStatus: input.resultStatus,
    },
    reusableMethod: null,
  };
}

function simulatorMethodRefEvent(input: {
  providerPaymentId: string;
  aliasResult: SimulatorAliasResult | null;
  clientId: string | null;
  subscriptionId: string | null;
  providerMethodRef: string | null;
}, paymentIntentId: string): NormalizedProviderPaymentWebhook {
  if (!input.aliasResult || !input.clientId || !input.providerMethodRef) {
    throw new Error("Invalid simulator reusable method event");
  }
  const occurredAt = new Date().toISOString();
  return {
    provider: "tpay",
    providerEventId: `sim:${input.providerPaymentId}:alias:${input.aliasResult}`,
    eventType: input.aliasResult === "accepted" ? "setup.succeeded" : "setup.failed",
    providerPaymentId: input.providerPaymentId,
    paymentIntentId,
    occurredAt,
    rawPayload: {
      provider: "tpay",
      simulator: true,
      eventKind: "payid_alias",
      providerPaymentId: input.providerPaymentId,
      aliasResult: input.aliasResult,
      paymentIntentId,
    },
    reusableMethod: {
      clientId: input.clientId,
      subscriptionId: input.subscriptionId,
      providerMethodRef: input.providerMethodRef,
      methodKind: "blik_payid",
      status: input.aliasResult === "accepted" ? "active" : "inactive",
      consentSnapshot: {
        provider: "tpay",
        simulator: true,
        aliasResult: input.aliasResult,
      },
    },
  };
}
