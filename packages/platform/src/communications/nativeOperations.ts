import type { PostgresDataGatewayOptions } from "../data/index.js";
import type { DeliveryReconciliationPort } from "./deliveryReconciliation.js";
import type { CommunicationRecipientKind } from "./consentPolicy.js";

export interface NativeCommunicationsOptions extends PostgresDataGatewayOptions { binding: string }
export type NativeObservationKind = "sent" | "delayed" | "delivered" | "bounced" | "complained" | "failed";
export interface NativeNetworkTarget {
  sourceKey: string;
  messageId: string;
  recipientEmail: string;
  templateReference: string;
  acceptedAt: string;
  /** Only a host that observed a real network acceptance may register this fact. */
  evidence: "network_accepted";
}
export interface NativeDeliveryEvidence {
  id: string; sourceKey: string; messageId: string; acceptedAt: string;
  observedState: NativeObservationKind | null; observedAt: string | null;
  lastPollAt: string | null; notFoundCount: number; abandonedAt: string | null;
  observations: { key: string; kind: NativeObservationKind; occurredAt: string; source: "poll" | "callback" }[];
}
export interface NativeDeliveryStore extends DeliveryReconciliationPort {
  registerNetworkTarget(input: NativeNetworkTarget): Promise<{ id: string }>;
  applyObservation(input: { sendId: string; messageId: string; observationKey: string; kind: NativeObservationKind; occurredAt: string; recipientEmail: string | null; source: "poll" | "callback" }): Promise<void>;
  readEvidence(sendId: string): Promise<NativeDeliveryEvidence | null>;
  close(): Promise<void>;
}
export type NativeNotificationType = "packaging_digest" | "new_signup" | "commerce_payment_critical";
export interface NativeNotificationRecipient { id: string; email: string; name: string | null; active: boolean; notification_type: NativeNotificationType; created_at: string }
export interface NativeConsentInput {
  email: string; purpose: string; recipientKind?: CommunicationRecipientKind;
  sourceTable?: "testers" | "waitlist" | "clients" | "b2b_inquiries" | "notification_recipients";
  sourceId?: string | null;
}
export interface NativeConsentDecision { allowed: boolean; reason: string; decisionId: string }
export class NativeConsentEvaluationUnavailableError extends Error {
  constructor(cause: unknown) { super("native_consent_evaluation_unavailable", { cause }); this.name = "ConsentEvaluationUnavailableError"; }
}
