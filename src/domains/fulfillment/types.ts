import {
  customerStepFromSignals,
  stepForToken,
  timelineLabelForStep,
  type CustomerFulfillmentStep,
} from "./statusMap.js";
import {
  customerSafeEvidenceToken,
  customerStepFromTimedSignals,
  type ResolvedProviderExceptionRecovery,
} from "../../lib/customerFulfillmentCanon.js";
export {
  customerStepFromSignals,
  phaseIndexForStep,
  timelineLabelForStep,
  type CustomerFulfillmentStep,
} from "./statusMap.js";
export {
  customerSafeEvidenceToken,
  customerStepForTerminalOrder,
  customerStepFromTimedSignals,
  type TimedFulfillmentSignal,
} from "../../lib/customerFulfillmentCanon.js";

function validTimestamp(value: string | null | undefined): number | null {
  if (!value || !/(?:[Zz]|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export const FULFILLMENT_PROVIDER = "dhl";

/** Bounded pull freshness for committed fulfillment changes; this is not Realtime. */
export const FULFILLMENT_VISIBLE_REFRESH_MS = 10_000;

const TERMINAL_FULFILLMENT_STATUSES = new Set(["delivered", "cancelled"]);

export function visibleFulfillmentRefreshInterval(
  fulfillmentStatuses: Array<string | null | undefined>,
): number | false {
  const documentState = (globalThis as { document?: { visibilityState?: string } }).document?.visibilityState;
  if (documentState !== "visible") return false;
  return fulfillmentStatuses.some(isNonTerminalFulfillment) ? FULFILLMENT_VISIBLE_REFRESH_MS : false;
}

export function isBlockingVisibleQueryError(isError: boolean, data: unknown): boolean {
  return isError && !data;
}

export const FULFILLMENT_SHIPMENT_STATUSES = [
  "packing",
  "shipped",
  "in_transit",
  "delivered",
] as const;

export type FulfillmentProvider = typeof FULFILLMENT_PROVIDER;
export type FulfillmentShipmentStatus = (typeof FULFILLMENT_SHIPMENT_STATUSES)[number];
export type FulfillmentDisplayStatus = "shipped" | "in_transit" | "delivered";

export interface FulfillmentSourceRef {
  system: "supabase";
  table: "testers";
  id: string;
}

export interface DhlTrackingEvents {
  codes: string[];
  descriptions: string[];
}

export interface ShipmentStatusReadModel {
  id: string;
  provider: FulfillmentProvider;
  status: FulfillmentDisplayStatus;
  trackingNumber: string | null;
  trackingUrl: string | null;
  statusUpdatedAt: string | null;
  deliveredAt: string | null;
  sourceRef: FulfillmentSourceRef;
}

export type FulfillmentEvidenceTimelineSource =
  | "webhook"
  | "reconciliation"
  | "manual"
  | "simulator"
  | "fulfillment";

export interface FulfillmentEvidenceShipmentRefRow {
  order_id?: string | null;
  provider_kind?: string | null;
  provider_tracking_id?: string | null;
  tracking_url?: string | null;
  carrier_kind?: string | null;
  service?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  active?: boolean | null;
}

export interface FulfillmentEvidenceStatusRow {
  id?: string | null;
  provider_status?: string | null;
  local_status?: string | null;
  evidence_kind?: string | null;
  occurred_at?: string | null;
  created_at?: string | null;
}

export interface FulfillmentEvidenceOperationRow {
  operation_type?: string | null;
  occurred_at?: string | null;
}

export interface FulfillmentEvidenceTrackingReference {
  providerKind: string;
  trackingNumber: string;
  trackingUrl: string | null;
  carrierKind: string | null;
  service: string | null;
  updatedAt: string | null;
}

export interface FulfillmentEvidenceTimelineEvent {
  eventType: string;
  label: string;
  occurredAt: string | null;
  source: FulfillmentEvidenceTimelineSource;
}

export function buildFulfillmentEvidenceSummary(input: {
  trackingRefs: FulfillmentEvidenceShipmentRefRow[];
  statusEvidenceRows: FulfillmentEvidenceStatusRow[];
  operationRows: FulfillmentEvidenceOperationRow[];
  recovery?: ResolvedProviderExceptionRecovery;
}) {
  const trackingReferences = input.trackingRefs
    .filter((row) => row.active !== false)
    .map(mapFulfillmentEvidenceTrackingReference)
    .filter((ref): ref is FulfillmentEvidenceTrackingReference => ref !== null)
    .sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt));
  const trackingTimeline = buildFulfillmentEvidenceTimeline(
    input.statusEvidenceRows,
    input.operationRows,
    input.recovery,
  );
  return {
    trackingReferences,
    trackingNumbers: trackingReferences.map((ref) => ref.trackingNumber),
    trackingNumber: trackingReferences[0]?.trackingNumber ?? null,
    trackingUrl: trackingReferences[0]?.trackingUrl ?? null,
    carrierKind: trackingReferences[0]?.carrierKind ?? null,
    service: trackingReferences[0]?.service ?? null,
    trackingTimeline,
  };
}

export function mapFulfillmentEvidenceTrackingReference(
  row: FulfillmentEvidenceShipmentRefRow,
): FulfillmentEvidenceTrackingReference | null {
  const trackingNumber = text(row.provider_tracking_id);
  if (!trackingNumber) return null;
  const providerKind = text(row.provider_kind) || "unknown";
  return {
    providerKind,
    trackingNumber,
    trackingUrl: nullableText(row.tracking_url),
    carrierKind: nullableText(row.carrier_kind) ?? inferCarrierKind(providerKind),
    service: nullableText(row.service),
    updatedAt: nullableText(row.updated_at) ?? nullableText(row.created_at),
  };
}

export function buildFulfillmentEvidenceTimeline(
  evidenceRows: FulfillmentEvidenceStatusRow[],
  operationRows: FulfillmentEvidenceOperationRow[],
  recovery?: ResolvedProviderExceptionRecovery,
): FulfillmentEvidenceTimelineEvent[] {
  const events = [
    ...evidenceRows.map((row) => {
      const event = mapFulfillmentEvidenceStatusEvent(row);
      return event ? {
        event,
        // The exact recovered evidence remains visible even if an earlier normal
        // packing milestone already occupies the usual collapsed timeline slot.
        verifiedRecovery: recovery?.recoveryEvidenceIds.has(text(row.id)) ?? false,
      } : null;
    }),
    ...operationRows.map((row) => {
      const event = mapFulfillmentEvidenceOperationEvent(row);
      return event ? { event, verifiedRecovery: false } : null;
    }),
  ].filter((entry): entry is { event: FulfillmentEvidenceTimelineEvent; verifiedRecovery: boolean } => entry !== null);
  // Collapse to the main customer-facing milestones. End customers care about the
  // headline stages (accepted -> preparing -> in transit -> delivered), not every
  // granular provider sub-status, so keep one occurrence per milestone. Keep the
  // FIRST preparation/transit occurrence, but the LATEST delivery or exception:
  // those two may legitimately alternate during redelivery/return handling.
  const byMilestone = new Map<string, FulfillmentEvidenceTimelineEvent>();
  for (const { event, verifiedRecovery } of events) {
    const key = verifiedRecovery ? `${event.label}:recovery:${event.eventType}` : event.label;
    const existing = byMilestone.get(key);
    const eventTime = validTimestamp(event.occurredAt);
    const existingTime = validTimestamp(existing?.occurredAt);
    const step = stepForToken(event.eventType);
    const keepsLatest = step === "exception" || step === "delivered";
    if (
      !existing
      || (eventTime !== null && existingTime === null)
      || (
        eventTime !== null
        && existingTime !== null
        && (keepsLatest ? eventTime > existingTime : eventTime < existingTime)
      )
    ) {
      byMilestone.set(key, event);
    }
  }
  return [...byMilestone.values()].sort((a, b) => timestamp(b.occurredAt) - timestamp(a.occurredAt)).slice(0, 8);
}

function mapFulfillmentEvidenceStatusEvent(row: FulfillmentEvidenceStatusRow): FulfillmentEvidenceTimelineEvent | null {
  const eventType = customerSafeEvidenceToken(
    nullableText(row.local_status),
    nullableText(row.provider_status),
  );
  if (!eventType) return null;
  return {
    eventType,
    label: labelForFulfillmentEvidenceEvent(eventType),
    occurredAt: nullableText(row.occurred_at),
    source: evidenceKind(row.evidence_kind),
  };
}

function mapFulfillmentEvidenceOperationEvent(
  row: FulfillmentEvidenceOperationRow,
): FulfillmentEvidenceTimelineEvent | null {
  const eventType = nullableText(row.operation_type);
  if (!eventType) return null;
  return {
    eventType,
    label: labelForFulfillmentEvidenceEvent(eventType),
    occurredAt: nullableText(row.occurred_at),
    source: "fulfillment",
  };
}

// Maps a raw provider/local/operation status token to the customer-facing
// milestone label shown in the order-detail timeline. Deliberately coarse: the
// end customer sees the main stages, not the provider's internal sub-steps.
//
// SOURCE OF TRUTH: config/fulfillment-status-map.json via ./statusMap.ts — the
// token→step mapping and the Polish milestone labels both live there, shared with
// the account progress bar / cards so they can never diverge. Do NOT add a
// parallel mapping here. An unknown future token falls to a safe generic label.
function labelForFulfillmentEvidenceEvent(eventType: string): string {
  const step = stepForToken(eventType);
  return step ? timelineLabelForStep(step) : "Status dostawy zaktualizowany";
}

function inferCarrierKind(providerKind: string): string | null {
  if (providerKind.includes("inpost")) return "inpost";
  if (providerKind.includes("omnipack")) return "omnipack";
  return providerKind || null;
}

function evidenceKind(value: unknown): FulfillmentEvidenceTimelineSource {
  return value === "webhook" || value === "reconciliation" || value === "manual" || value === "simulator"
    ? value
    : "fulfillment";
}

function timestamp(value: string | null): number {
  return value ? Date.parse(value) || 0 : 0;
}

function isNonTerminalFulfillment(status: string | null | undefined): boolean {
  const value = status?.trim().toLowerCase();
  return value !== undefined && value !== "" && !TERMINAL_FULFILLMENT_STATUSES.has(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
