import type { OmnipackDispatchAcceptanceResult } from "./omnipackDispatchAcceptance.js";

export type { OmnipackDispatchAcceptanceResult } from "./omnipackDispatchAcceptance.js";

export type OmnipackDispatchMode = "shadow" | "stage" | "live";
export type OmnipackDispatchRefStatus =
  | "draft"
  | "submitting"
  | "created"
  | "uncertain"
  | "failed"
  | "cancel_requested"
  | "cancelled";

export interface OmnipackProviderClient {
  createOrder(payload: Record<string, unknown>): Promise<{ providerOrderId: string }>;
}

export interface OmnipackDeliverySelectionEvidence {
  providerKind?: string | null;
  carrierKind?: string | null;
  carrierCode?: string | null;
  service?: string | null;
  serviceCode?: string | null;
  deliveryKind?: string | null;
  kind?: string | null;
  providerRef?: string | null;
  pickupPoint?: {
    id?: string | null;
    pointId?: string | null;
    name?: string | null;
    address?: {
      line1?: string | null;
      postalCode?: string | null;
      city?: string | null;
      country?: string | null;
    } | null;
  } | null;
}

export interface OmnipackDeliveryContactSnapshot {
  schemaVersion: number;
  source: string;
  revision: number;
  recipientName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  postalCode: string;
  country: string;
  selectedDelivery: OmnipackDeliverySelectionEvidence | null;
  deliveryInstructions: string | null;
  courierInstructions: string | null;
}

export interface OmnipackDispatchCandidate {
  fulfillmentOrderId: string;
  orderId: string;
  orderNumber: string | null;
  status: string;
  /** The only authority for a provider request. Legacy rows must be normalized
   * into an explicitly labelled `legacy_inferred` snapshot by the mapper. */
  deliveryContact: OmnipackDeliveryContactSnapshot | null;
  client: { email: string | null; firstName: string | null; lastName: string | null; phone: string | null };
  shippingAddress: {
    label: string | null;
    /** Frozen at fulfilment creation. Null only on rows written before that snapshot key existed. */
    recipientName: string | null;
    line1: string;
    city: string;
    postalCode: string;
    country: string;
  };
  deliverySelection: OmnipackDeliverySelectionEvidence | null;
  lines: Array<{ sku: string; title: string | null; quantity: number; productSnapshot: Record<string, unknown> }>;
}

export const OMNIPACK_DISPATCH_CONTACT_STALE = "omnipack_dispatch_contact_stale";

export function isOmnipackDispatchContactStale(error: unknown): boolean {
  return error instanceof Error && error.message === OMNIPACK_DISPATCH_CONTACT_STALE;
}

export interface OmnipackDispatchRefResult {
  dispatchRefId: string;
  fulfillmentOrderId: string;
  orderId: string;
  providerOrderId: string | null;
  status: OmnipackDispatchRefStatus;
  replayed: boolean;
}

export interface OmnipackDispatchReadBack {
  id: string;
  fulfillment_order_id: string;
  order_id: string;
  provider_order_id: string | null;
  dispatch_mode: OmnipackDispatchMode;
  status: OmnipackDispatchRefStatus;
  request_idempotency_key: string;
  sanitized_request: Record<string, unknown>;
}

export interface OmnipackDispatchSubmissionResult extends OmnipackDispatchReadBack {
  begun: boolean;
  replayed: boolean;
}

export interface OmnipackDispatchContactPreparation {
  disposition: "ready" | "withheld";
  deliveryContactRevision: number | null;
}

export interface OmnipackDispatchPort {
  listCandidates(limit: number): Promise<OmnipackDispatchCandidate[]>;
  readCandidateByFulfillmentOrderId(fulfillmentOrderId: string): Promise<OmnipackDispatchCandidate | null>;
  prepareDispatchContact(fulfillmentOrderId: string): Promise<OmnipackDispatchContactPreparation>;
  markStaleSubmissionsUncertain(staleBefore: string): Promise<number>;
  recordProviderAttempt(input: {
    idempotencyKey: string;
    fulfillmentOrderId: string;
    status: "recorded" | "succeeded" | "failed";
    requestPayload: Record<string, unknown>;
    responsePayload: Record<string, unknown>;
    error: string | null;
    metadata: Record<string, unknown>;
  }): Promise<{ replayed: boolean }>;
  recordDispatchRef(input: {
    idempotencyKey: string;
    fulfillmentOrderId: string;
    providerOrderId: string | null;
    dispatchMode: OmnipackDispatchMode;
    status: "draft";
    requestFingerprint: string;
    sanitizedRequest: Record<string, unknown>;
    sanitizedResponse: Record<string, unknown>;
    error: Record<string, unknown>;
  }): Promise<OmnipackDispatchRefResult>;
  readDispatchRefByIdempotencyKey(idempotencyKey: string): Promise<OmnipackDispatchReadBack | null>;
  beginSubmission(input: {
    dispatchRefId: string;
    requestFingerprint: string;
  }): Promise<OmnipackDispatchSubmissionResult>;
  acknowledgeDispatchAcceptance(input: {
    dispatchRefId: string;
    providerOrderId: string | null;
    providerAttemptIdempotencyKey: string;
    labelIdempotencyKey: string;
    sanitizedRequest: Record<string, unknown>;
    sanitizedResponse: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }): Promise<OmnipackDispatchAcceptanceResult>;
  finalizeSubmission(input: {
    dispatchRefId: string;
    providerOrderId: string | null;
    mayHaveSucceeded: boolean;
    sanitizedResponse: Record<string, unknown>;
    error: Record<string, unknown>;
  }): Promise<OmnipackDispatchReadBack>;
}

export interface OmnipackDispatchJobConfig {
  mode: OmnipackDispatchMode;
  batchLimit: number;
}

export interface OmnipackDispatchJobResult {
  ok: boolean;
  checked: number;
  updated: number;
  failures: number;
  skipped: boolean;
  reason?: string;
  mode: OmnipackDispatchMode;
  replayed: number;
  providerCalls: number;
  readBacks: number;
}

export function readOmnipackDispatchMode(env: Record<string, string | undefined>): OmnipackDispatchMode {
  const value = env.COMMERCE_OMNIPACK_DISPATCH_MODE;
  if (value === "stage" || value === "live") return value;
  return "shadow";
}

export function readOmnipackDispatchBatchLimit(env: Record<string, string | undefined>): number {
  const parsed = Number(env.COMMERCE_OMNIPACK_DISPATCH_BATCH_LIMIT);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 100 ? parsed : 25;
}

export function dispatchIdempotencyKey(fulfillmentOrderId: string): string {
  return `omnipack-dispatch:${fulfillmentOrderId}`;
}
