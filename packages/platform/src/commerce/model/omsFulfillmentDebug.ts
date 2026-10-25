import type { OmsFulfillmentProviderStockCurrentRow,OmsInboundProviderEventRow } from "../contracts/omsTypes.js";
import type { OmsOrderDetail } from "../oms/omsContracts.js";
import {
parseTimestampOrZero,
type OmsProviderAttemptRow,
type OmsProviderDispatchRefRow,
type OmsProviderStatusEvidenceRow,
} from "./omsFulfillmentSummary.js";
import type { OmsReadModelProjections } from "./omsReadModelProjections.js";
import type { OmsCommunicationDeliveryRow,OmsInventoryReservationRow } from "./omsReadModelRows.js";
export type { OmsFulfillmentProviderStockCurrentRow,OmsInboundProviderEventRow } from "../contracts/omsTypes.js";

type Debug = OmsOrderDetail["fulfillmentDebug"];
type Step = Debug["steps"][number];

export function buildOmsFulfillmentDebug(input: {
  projections?: OmsReadModelProjections;
  paymentStatus: OmsOrderDetail["paymentStatus"];
  inventory: OmsOrderDetail["inventory"];
  fulfillment: OmsOrderDetail["fulfillment"];
  reservations: OmsInventoryReservationRow[];
  communicationDeliveries: OmsCommunicationDeliveryRow[];
  providerAttempts: OmsProviderAttemptRow[];
  providerDispatchRefs: OmsProviderDispatchRefRow[];
  providerStatusEvidence: OmsProviderStatusEvidenceRow[];
  inboundProviderEvents: OmsInboundProviderEventRow[];
  providerStockCurrent?: OmsFulfillmentProviderStockCurrentRow[];
}): Debug {
  const latestDispatch = newest(input.providerDispatchRefs, (row) => row.updated_at ?? row.created_at);
  const latestAttempt = newest(input.providerAttempts, (row) => row.created_at);
  const latestProvider = newest(input.providerStatusEvidence, (row) => row.occurred_at ?? row.created_at);
  const latestInbound = newest(input.inboundProviderEvents, (row) => row.processed_at ?? row.created_at);
  const dispatchedMail = latestMail(input.communicationDeliveries, "commerce-shipment-dispatched");
  const providerProblem = latestInbound?.processing_status === "ignored" || latestInbound?.processing_status === "failed" ||
    Boolean(latestDispatch?.error) || Boolean(latestAttempt?.error) || ["failed", "error"].includes(latestAttempt?.status ?? "");
  const shippedWithoutTracking = Boolean(latestProvider && ["shipped", "delivered"].includes(latestProvider.provider_status ?? "")) &&
    input.fulfillment.trackingReferences.length === 0;
  const latestProviderStock = newest(input.providerStockCurrent ?? [], (row) => row.last_synced_at);
  const providerStockStale = latestProviderStock ? Date.parse(latestProviderStock.stale_after) <= Date.now() : false;

  const steps: Step[] = [
    step("payment", input.paymentStatus === "succeeded" ? "ok" : "blocked", "Payment", input.paymentStatus),
    step("stock", ["reserved", "consumed"].includes(input.inventory.status) ? "ok" : "missing", "Stock", input.inventory.status, {
      details: input.reservations.map((row) => `${row.status}:${row.quantity}`),
      evidenceAt: input.inventory.expiresAt,
    }),
    step(
      "provider_stock",
      providerStockStatus(Boolean(input.projections?.usesExternalStock?.(input.fulfillment.providerKind)), latestProviderStock, providerStockStale),
      "Provider stock",
      latestProviderStock ? `${latestProviderStock.provider_kind}:${latestProviderStock.sku}` : null,
      {
        details: latestProviderStock
          ? [
              `forSale ${latestProviderStock.provider_for_sale_quantity}`,
              `total ${latestProviderStock.provider_total_quantity}`,
              `authority ${input.projections?.usesExternalStock?.(input.fulfillment.providerKind) ? "external_stock_master" : "local_atp"}`,
            ]
          : [],
        evidenceAt: latestProviderStock?.last_synced_at ?? null,
      },
    ),
    step("fulfillment", input.fulfillment.fulfillmentOrderId ? "ok" : "missing", "Fulfillment order", input.fulfillment.status),
    step("dispatch", latestDispatch ? statusFromDispatch(latestDispatch) : "pending", input.projections?.dispatchStepLabel ?? "Provider dispatch", latestDispatch?.status ?? null, {
      details: compact([latestDispatch?.provider_order_id ? `providerOrderId ${latestDispatch.provider_order_id}` : null, latestAttempt?.status ? `attempt ${latestAttempt.status}` : null]),
      evidenceAt: latestDispatch?.updated_at ?? latestDispatch?.created_at ?? null,
    }),
    step("provider", providerProblem ? "warning" : latestProvider ? "ok" : "pending", "Provider evidence", latestProvider?.provider_status ?? latestInbound?.processing_status ?? null, {
      details: compact([latestProvider?.provider_sub_status, latestInbound?.event_type, latestAttempt?.status ? `attempt ${latestAttempt.status}` : null, errorSummary(latestInbound?.error), errorSummary(latestAttempt?.error)]),
      evidenceAt: latestProvider?.occurred_at ?? latestProvider?.created_at ?? latestInbound?.created_at ?? null,
    }),
    step("tracking", shippedWithoutTracking ? "missing" : input.fulfillment.trackingReferences.length > 0 ? "ok" : "pending", "Tracking refs", input.fulfillment.providerTrackingId, {
      details: input.fulfillment.trackingReferences.map((ref) => compact([ref.trackingNumber, ref.carrierKind, ref.service]).join(" / ")),
      evidenceAt: input.fulfillment.trackingReferences[0]?.updatedAt ?? null,
    }),
    step("communication", mailStatus(dispatchedMail), "Customer e-mail", dispatchedMail?.status ?? null, {
      details: dispatchedMail ? compact([dispatchedMail.template_slug, dispatchedMail.last_error_code]) : [],
      evidenceAt: dispatchedMail?.updated_at ?? dispatchedMail?.created_at ?? null,
    }),
  ];
  const nextAction = chooseNextAction({ input, latestDispatch, providerProblem, shippedWithoutTracking });
  const blockers = steps.filter((entry) => entry.status === "blocked" || entry.status === "missing" || entry.status === "warning").map((entry) => entry.label);
  return {
    summary: input.projections?.debugSummary?.(nextAction) ?? summaryFor(nextAction),
    severity: blockers.length ? "action_required" : steps.some((entry) => entry.status === "pending") ? "watch" : "ok",
    nextAction,
    blockers,
    steps,
  };
}

function chooseNextAction(input: {
  input: Parameters<typeof buildOmsFulfillmentDebug>[0];
  latestDispatch: OmsProviderDispatchRefRow | null;
  providerProblem: boolean;
  shippedWithoutTracking: boolean;
}): Debug["nextAction"] {
  if (input.input.paymentStatus !== "succeeded") return "review_payment";
  if (!["reserved", "consumed"].includes(input.input.inventory.status)) return "review_stock";
  const latestProviderStock = newest(input.input.providerStockCurrent ?? [], (row) => row.last_synced_at);
  if (input.input.projections?.usesExternalStock?.(input.input.fulfillment.providerKind) && !latestProviderStock) return "review_stock";
  if (latestProviderStock && Date.parse(latestProviderStock.stale_after) <= Date.now()) return "review_stock";
  if (!input.input.fulfillment.fulfillmentOrderId) return "create_fulfillment";
  if (input.providerProblem) return "review_provider";
  if (!input.latestDispatch && input.input.projections?.usesExternalStock?.(input.input.fulfillment.providerKind)) return "retry_dispatch";
  if (input.shippedWithoutTracking) return "reconcile";
  return "wait";
}

function providerStockStatus(
  usesExternalStock: boolean,
  stock: OmsFulfillmentProviderStockCurrentRow | null,
  stale: boolean,
): Step["status"] {
  if (!usesExternalStock) return "ok";
  if (!stock) return "missing";
  return stale ? "warning" : "ok";
}

function step(key: Step["key"], status: Step["status"], label: string, value: string | null | undefined, extra: Partial<Step> = {}): Step {
  return { key, status, label, value: value ?? null, evidenceAt: extra.evidenceAt ?? null, details: extra.details ?? [] };
}

function statusFromDispatch(row: OmsProviderDispatchRefRow): Step["status"] {
  if (row.error || row.status === "failed") return "warning";
  return row.status ? "ok" : "pending";
}

function mailStatus(row: OmsCommunicationDeliveryRow | null): Step["status"] {
  if (!row) return "pending";
  if (["bounced", "complained", "missed", "blocked", "delivery_delayed"].includes(row.status)) return "warning";
  if (["sent", "delivered"].includes(row.status)) return "ok";
  return "pending";
}

function latestMail(rows: OmsCommunicationDeliveryRow[], slug: string): OmsCommunicationDeliveryRow | null {
  return newest(rows.filter((row) => row.template_slug === slug || row.purpose === "shipment_dispatched"), (row) => row.updated_at ?? row.created_at);
}

function newest<T>(rows: T[], time: (row: T) => string | null | undefined): T | null {
  return [...rows].sort((a, b) => parseTimestampOrZero(time(b)) - parseTimestampOrZero(time(a)))[0] ?? null;
}

function summaryFor(action: Debug["nextAction"]): string {
  return { wait: "Monitor the next event.", create_fulfillment: "Create a fulfillment order.", retry_dispatch: "Review or retry provider dispatch.", reconcile: "Reconcile tracking and status.", review_payment: "Review payment first.", review_stock: "Review stock reservations first.", review_provider: "Review provider evidence.", contact_support: "Contact technical support." }[action];
}

function errorSummary(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "reason" in value && typeof value.reason === "string") return value.reason;
  return "error_present";
}

function compact(values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value && value.trim()));
}
