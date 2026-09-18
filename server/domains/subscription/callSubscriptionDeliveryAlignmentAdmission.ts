import type {
  DueSubscription,
  SubscriptionRenewalChargeResult,
} from "./chargeSubscriptionCycleOffSession.js";

/**
 * Thin parser for the atomic delivery-aware renewal admission RPC. The RPC is
 * the authority: TypeScript must stop before snapshots/order/payment work when
 * it returns `allowed=false`.
 */
export interface DeliveryAlignmentAdmission {
  allowed: boolean;
  state: string;
  reason: string;
}

export type AllowedDeliveryAlignmentAdmission = DeliveryAlignmentAdmission & { allowed: true };

export type DeliveryAlignmentAdmissionCheck =
  | { admitted: AllowedDeliveryAlignmentAdmission; blocked: null }
  | { admitted: null; blocked: SubscriptionRenewalChargeResult };

export interface DeliveryAlignmentAdmissionClient {
  admitDeliveryAlignment(input: { subscriptionId: string; scheduledAt: string; asOf: string }): Promise<DeliveryAlignmentAdmission>;
}

export async function callSubscriptionDeliveryAlignmentAdmission(
  client: DeliveryAlignmentAdmissionClient,
  input: { subscriptionId: string; scheduledAt: string; asOf: string },
): Promise<DeliveryAlignmentAdmission> {
  return client.admitDeliveryAlignment(input);
}

export function parseDeliveryAlignmentAdmissionResponse(
  data: unknown,
  error: { code?: string; message?: string } | null,
): DeliveryAlignmentAdmission {
  if (error) {
    throw new Error(`subscription_delivery_alignment_admission_failed: ${error.message ?? error.code ?? "unknown"}`);
  }
  if (!isRecord(data)
    || typeof data.allowed !== "boolean"
    || typeof data.state !== "string"
    || typeof data.reason !== "string") {
    throw new Error("subscription_delivery_alignment_admission_invalid_response");
  }
  return { allowed: data.allowed, state: data.state, reason: data.reason };
}

export async function deliveryAlignmentBlockResult(
  client: DeliveryAlignmentAdmissionClient,
  due: DueSubscription,
  asOf: string,
): Promise<SubscriptionRenewalChargeResult | null> {
  return (await checkSubscriptionDeliveryAlignmentAdmission(client, due, asOf)).blocked;
}

export async function checkSubscriptionDeliveryAlignmentAdmission(
  client: DeliveryAlignmentAdmissionClient,
  due: DueSubscription,
  asOf: string,
): Promise<DeliveryAlignmentAdmissionCheck> {
  const admission = await callSubscriptionDeliveryAlignmentAdmission(client, {
    subscriptionId: due.subscriptionId,
    scheduledAt: due.nextCycleAt,
    asOf,
  });
  if (admission.allowed) {
    return { admitted: admission as AllowedDeliveryAlignmentAdmission, blocked: null };
  }
  return { admitted: null, blocked: {
    subscriptionId: due.subscriptionId,
    outcome: "skipped",
    cycleId: null,
    cycleNumber: null,
    orderId: null,
    paymentIntentId: null,
    attemptStatus: null,
    replayed: false,
    reason: admission.reason,
  } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
