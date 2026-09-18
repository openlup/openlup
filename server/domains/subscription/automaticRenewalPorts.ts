import type { PaymentProviderCapabilityDescriptor } from "@openlup/core/payment";
import type { PreparedProviderAttemptRuntimePort } from "../../../src/domains/commerce/ports.js";
import type { PaymentExecutionPort } from "../../../src/domains/payment/ports.js";
import type { PaymentAttemptStatus } from "../../../src/domains/payment/types.js";
import type { DeliveryAlignmentAdmissionClient, AllowedDeliveryAlignmentAdmission } from "./callSubscriptionDeliveryAlignmentAdmission.js";
import type { CycleChargeFailurePropagationPort } from "./propagateSubscriptionCycleChargeFailure.js";

export type AutomaticRenewalContractVersion = "platform.subscription.renewal.v1";

export interface AutomaticRenewalDue {
  subscriptionId: string;
  clientId: string;
  scheduledAt: string;
  cadenceDays: number;
  cycleNumber: number;
  currency: string;
  stockSourceKey: string;
  settlementChannelKey: string;
  authorizationRef: string;
  payerAccountRef: string | null;
  unattendedChargeAuthorizedAt: string;
  deliveryAdmission: "allowed" | "blocked";
  deliveryBlockReason: string | null;
}

export interface AutomaticRenewalCycleSnapshot {
  contractVersion: AutomaticRenewalContractVersion;
  subscriptionId: string;
  clientId: string;
  scheduledAt: string;
  cycleNumber: number;
  currency: string;
  totalAmountMinor: number;
  stockSourceKey: string;
  settlementChannelKey: string;
  authorizationRef: string;
  payerAccountRef: string | null;
  lines: Array<{
    lineOrdinal: number;
    sku: string;
    quantity: number;
    unitAmountMinor: number;
  }>;
}

export type AutomaticRenewalState =
  | "claimed"
  | "reserved"
  | "attempt_prepared"
  | "succeeded"
  | "refused";

export interface AutomaticRenewalReadback {
  contractVersion: AutomaticRenewalContractVersion;
  acquired: boolean;
  replayed: boolean;
  reason: string;
  operationId: string;
  identityKey: string;
  operationFingerprint: string;
  subscriptionId: string;
  scheduledAt: string;
  cycleNumber: number;
  state: AutomaticRenewalState;
  claimToken: string;
  claimGeneration: number;
  leaseExpiresAt: string;
  cycleSnapshot: AutomaticRenewalCycleSnapshot;
  externalAttemptRef: string | null;
  externalAttemptAcknowledgedAt: string | null;
  terminalOutcome: "succeeded" | "refused" | null;
  terminalReason: string | null;
  terminalAt: string | null;
  reservationId: string | null;
  cycleId: string | null;
  orderId: string | null;
  settlementIntentId: string | null;
}

export interface AutomaticRenewalStorePort {
  listDue(limit: number, asOf: string): Promise<AutomaticRenewalDue[]>;
  buildCycleSnapshots(input: {
    subscriptionId: string;
    scheduledAt: string;
  }): Promise<AutomaticRenewalCycleSnapshot>;
  readMandateEvidence(input: {
    subscriptionId: string;
    scheduledAt: string;
  }): Promise<{ authorized: true; authorizationRef: string; authorizedAt: string }>;
  admitDeliveryAlignment(input: {
    subscriptionId: string;
    scheduledAt: string;
  }): Promise<{ allowed: boolean; reason: string | null }>;
  claimDue(input: {
    snapshot: AutomaticRenewalCycleSnapshot;
    workerId: string;
    leaseSeconds?: number;
    now: string;
  }): Promise<AutomaticRenewalReadback>;
  readRenewal(identityKey: string): Promise<AutomaticRenewalReadback | null>;
  refuseBeforePayment(input: {
    operationId: string;
    claimToken: string;
    reason: string;
    occurredAt: string;
  }): Promise<AutomaticRenewalReadback>;
}

export interface AutomaticRenewalReservationResult {
  reserved: boolean;
  replayed: boolean;
  reservationId: string | null;
  status: "held" | "committed" | "consumed" | "released" | "expired" | "refused";
  reason: string | null;
}

export interface AutomaticRenewalInventoryPort {
  reserve(input: {
    operationId: string;
    claimToken: string;
    holdSeconds?: number;
    now: string;
  }): Promise<AutomaticRenewalReservationResult>;
  releaseReservation(input: {
    operationId: string;
    claimToken: string;
    reason: string;
    now: string;
  }): Promise<Record<string, unknown>>;
  expireReservations(input: { now: string; limit?: number }): Promise<number>;
}

export interface AutomaticRenewalPreparedSettlement {
  contractVersion: AutomaticRenewalContractVersion;
  replayed: boolean;
  operationId: string;
  operationFingerprint: string;
  cycleId: string;
  orderId: string;
  settlementIntentId: string;
  state: "attempt_prepared";
}

export interface AutomaticRenewalSettlementPort {
  prepareRenewal(input: {
    operationId: string;
    claimToken: string;
    now: string;
  }): Promise<AutomaticRenewalPreparedSettlement>;
  acknowledgeExternalAttempt(input: {
    operationId: string;
    operationFingerprint: string;
    externalAttemptRef: string;
    acknowledgedAt: string;
  }): Promise<Record<string, unknown>>;
  recordTerminalOutcome(input: {
    operationId: string;
    eventKey: string;
    operationFingerprint: string;
    outcome: "succeeded" | "refused";
    externalRef?: string | null;
    reason?: string | null;
    occurredAt: string;
  }): Promise<Record<string, unknown>>;
}

export interface AutomaticRenewalPaymentRail {
  executionPort: PaymentExecutionPort;
  /** Recover a provider acknowledgement after the process died before local persistence. */
  findExternalAttempt?(input: {
    settlementIntentId: string;
  }): Promise<string | null>;
  readOutcome(input: {
    externalAttemptRef: string;
    settlementIntentId: string;
    orderId: string;
    subscriptionId: string;
    amountMinor: number;
    currency: string;
  }): Promise<{
    status: "succeeded" | "failed" | "pending" | "unknown";
    occurredAt: string | null;
    reason: string | null;
    amountMinor: number | null;
    currency: string | null;
  }>;
}

export interface AutomaticRenewalPaymentRailResolver {
  resolve(channelKey: string): AutomaticRenewalPaymentRail | null;
}

export interface AutomaticRenewalFailureHandoffResult {
  caseId: string | null;
  replayed: boolean;
}

/**
 * C-D16 owns only the failure boundary. The implementation is supplied by the
 * merged C-D15 lifecycle; it must not calculate retry cadence or open a second
 * case store here.
 */
export interface AutomaticRenewalFailureHandoffPort {
  handoffFailure(input: {
    idempotencyKey: string;
    subscriptionId: string;
    clientId: string;
    cycleId: string;
    orderId: string;
    paymentIntentId: string;
    failureClass: string;
    failureReason: string;
    /**
     * When the next attempt is due, or `null` for "there is no next attempt".
     * Decided by the caller, beside the class, because those are one decision:
     * whether this refusal is worth retrying and when. The implementation must
     * take this value as given — an implementation that re-derives a schedule
     * the caller cleared would file a case that contradicts its own cycle, and
     * would make an early terminal indistinguishable from an exhausted ladder.
     */
    nextRetryAt: string | null;
    occurredAt: string;
    amountMinor: number;
    currency: string;
  }): Promise<AutomaticRenewalFailureHandoffResult>;
}

export type SubscriptionRenewalOutcome = "charged" | "requires_action" | "failed" | "skipped";
export interface DueSubscription {
  subscriptionId: string; clientId: string; nextCycleAt: string; currency: string; providerKind: string;
  providerCustomerRef: string | null; providerMethodRef: string | null; methodKind: string;
  payerEmail: string | null; payerName: string | null;
  methodStatus?: string | null; methodActive?: boolean | null; methodExpiresAt?: string | null; methodClientId?: string | null;
}
export interface SubscriptionRenewalChargeResult {
  subscriptionId: string; outcome: SubscriptionRenewalOutcome; cycleId: string | null;
  cycleNumber: number | null; orderId: string | null; paymentIntentId: string | null;
  attemptStatus: PaymentAttemptStatus | null; replayed: boolean; dunningCaseId?: string | null;
  retryAttempt?: number | null; applyReplayed?: boolean; dunningPropagationFailed?: boolean; reason?: string;
}
export interface SubscriptionCycleSnapshotResult {
  cycleNumber: number; retryAttempt: number; providerAttemptSequence: number;
  templateSnapshot: Record<string, unknown>; pricingSnapshot: Record<string, unknown>;
  orderSnapshot: Record<string, unknown>;
}
export interface SubscriptionCycleOrderInput {
  idempotencyKey: string; subscriptionId: string; cycleNumber: number; scheduledAt: string;
  templateSnapshot: Record<string, unknown>; pricingSnapshot: Record<string, unknown>;
  orderSnapshot: Record<string, unknown>;
}
export interface SubscriptionCycleOrderResult {
  cycleId: string; orderRef: string; orderUuid: string; paymentRef: string; replayed: boolean;
}
export interface SubscriptionReservationPreflightResult {
  ok: boolean; reason: string | null; itemsChecked: number; reacquired: number;
}
/** Narrow persistence boundary for the legacy managed renewal composition. */
export interface SubscriptionRenewalPersistencePort {
  buildCycleSnapshots(input: { subscriptionId: string; scheduledAt: string }): Promise<SubscriptionCycleSnapshotResult>;
  createCycleOrder(input: SubscriptionCycleOrderInput): Promise<SubscriptionCycleOrderResult>;
  preflightReservation(input: { orderId: string; now: string }): Promise<SubscriptionReservationPreflightResult>;
  readMandateRecurringModel(providerKind: string, providerMethodRef: string | null): Promise<"O" | "M" | undefined>;
  noteRowOutcome(input: { subscriptionId: string; scheduledAt: string; errorKey: string | null }): Promise<void>;
}
export interface SubscriptionRenewalChargeDeps {
  persistence: SubscriptionRenewalPersistencePort;
  deliveryAlignment: DeliveryAlignmentAdmissionClient;
  chargeFailurePropagation: CycleChargeFailurePropagationPort;
  paymentPort: PreparedProviderAttemptRuntimePort;
  executionPort: PaymentExecutionPort;
  capability: PaymentProviderCapabilityDescriptor;
  deliveryAlignmentAdmission?: AllowedDeliveryAlignmentAdmission;
  now?: () => string;
}
