import type { AlertDecision, ObservabilitySnapshot } from "./observabilityContracts.js";

const RUNBOOK_URL = "/docs/platform/RUNTIME_AND_SELF_HOSTING.md";

export function collectOmniPackAlerts(
  decisions: AlertDecision[],
  snapshot: ObservabilitySnapshot,
): void {
  // Flag-independent (docs/platform/RUNTIME_AND_SELF_HOSTING.md): a paid order stuck
  // mid-fulfillment is a data-integrity problem regardless of which
  // observability gate is on — neither the picking/shipping webhooks nor the
  // reconciliation fallback advanced it within the SLA.
  pushCountAlert(
    decisions,
    snapshot.omnipack.frozenFulfillmentCount ?? 0,
    "omnipack_fulfillment_status_frozen",
    "OmniPack fulfillment status frozen mid-pipeline",
    "p1",
  );
  // p2 ON PURPOSE — do not "upgrade" this to p1 casually. The 72h label_created
  // SLA is a reasoned guess, not measured data. p2 is below
  // DEFAULT_PAGING_MIN_SEVERITY ("p0", alertPagingPolicy.ts), and so is p1,
  // which is now panel-urgent rather than paging, so this lands in
  // the ledger without paging while we measure the real
  // label_created -> handed_over distribution. Promote only once that
  // distribution exists and the cutoff is derived from it.
  pushCountAlert(
    decisions,
    snapshot.omnipack.frozenLabelCreatedCount ?? 0,
    "omnipack_fulfillment_label_created_frozen",
    "Fulfillment label created but not collected",
    "p2",
  );
  // Flag-independent and p1: the dispatched-email trigger RETURNs without
  // writing an outbox row when no active shipment_external_refs row exists, so
  // no planned communication_email_deliveries row is ever created and
  // customer_email_delivery_missed cannot fire for this case by construction.
  // The customer already sees "W drodze" with no email and no tracking link.
  // Self-resolves: the ref lands -> trigger -> outbox -> email -> count drops.
  pushCountAlert(
    decisions,
    snapshot.omnipack.handedOverWithoutTrackingRefCount ?? 0,
    "shipment_handed_over_without_tracking_ref",
    "Shipment handed over without a customer tracking reference",
    "p1",
  );
  pushFulfillmentHealthAlert(
    decisions,
    snapshot,
    "blocked_uncertain",
    "omnipack_fulfillment_blocked_uncertain",
    "OmniPack fulfillment blocked on an uncertain dispatch result",
  );
  pushFulfillmentHealthAlert(
    decisions,
    snapshot,
    "local_ahead",
    "omnipack_fulfillment_local_ahead",
    "OmniPack fulfillment local status ahead of provider evidence",
  );
  pushFulfillmentHealthAlert(
    decisions,
    snapshot,
    "provider_ahead",
    "omnipack_fulfillment_provider_ahead",
    "OmniPack accepted dispatch but local label acknowledgement is missing",
  );

  if (snapshot.runtimeFlags.COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED !== true) return;
  const health = snapshot.omnipack;
  const stockSyncRootAlert = decisions.find((decision) =>
    decision.dedupeKey === "job_failed:omnipack-stock-sync" ||
    decision.dedupeKey === "job_missed:omnipack-stock-sync"
  );
  pushCountAlert(decisions, health.paidOrderMissingDispatchRefCount ?? 0, "omnipack_paid_order_missing_dispatch_ref", "Paid OmniPack orders missing dispatch proof", "p0");
  // Data integrity, not "not shipping": the order did ship, by another provider.
  pushCountAlert(decisions, health.wrongFulfillmentProviderCount ?? 0, "omnipack_selected_wrong_fulfillment_provider", "OmniPack-selected orders fulfilled by another provider", "p1");
  // Data integrity, not "not shipping": the dispatch ref exists, its provider order id does not.
  pushCountAlert(decisions, health.missingProviderOrderIdCount ?? 0, "omnipack_dispatch_missing_provider_order_id", "OmniPack dispatch refs missing provider order id", "p1");
  pushCountAlert(decisions, health.payloadMismatchCount ?? 0, "omnipack_payload_dictionary_mismatch", "OmniPack dispatch payload dictionary mismatch", "p1");
  // At 2 the dispatch rail itself is down and paid orders stop reaching the
  // fulfillment provider at all; at 1 it is one order an operator can retry.
  pushCountAlert(decisions, health.dispatchFailureCount, "omnipack_dispatch_failed", "OmniPack dispatch failures", health.dispatchFailureCount >= 2 ? "p0" : "p1");
  pushCountAlert(
    decisions,
    health.staleStockSyncCount,
    "omnipack_stock_sync_stale",
    "OmniPack stock sync stale",
    stockSyncRootAlert ? "p2" : "p1",
    stockSyncRootAlert ? "never" : "default",
    stockSyncRootAlert?.dedupeKey,
  );
  pushCountAlert(decisions, health.actionableShortageEvidenceCount, "omnipack_low_stock", "OmniPack actionable shortage evidence", "p1");
  pushReservationCoverageAlert(decisions, snapshot);
  pushCountAlert(decisions, health.unknownStockSkuCount ?? 0, "omnipack_provider_stock_unclassified_sku", "OmniPack provider stock contains unclassified SKUs", "p2", "never");
  pushCountAlert(decisions, health.reconciliationStateConflictCount ?? 0, "omnipack_reconciliation_state_conflict", "OmniPack reconciliation blocked by local fulfillment state", "p1");
  pushCountAlert(decisions, health.recentQuarantinedInboundCount, "omnipack_inbound_quarantined", "OmniPack inbound events quarantined in the last 24 hours (unmatched shipments)", "p1");
}

function pushReservationCoverageAlert(
  decisions: AlertDecision[],
  snapshot: ObservabilitySnapshot,
): void {
  const count = snapshot.omnipack.reservationCoverageCount ?? 0;
  if (count <= 0) return;
  const evidence = (snapshot.omnipack.reservationCoverageEvidence ?? []).slice(0, 10);
  const skus = evidence.map((row) => row.sku);
  const shownSkus = skus.slice(0, 5);
  const remainingCount = Math.max(0, count - shownSkus.length);
  const affected = shownSkus.length > 0
    ? `${shownSkus.join(", ")}${remainingCount > 0 ? ` (+${remainingCount})` : ""}`
    : "see durable evidence";

  decisions.push({
    dedupeKey: "omnipack_reservation_coverage",
    severity: "p1",
    owner: "commerce/fulfillment",
    runbookUrl: RUNBOOK_URL,
    title: "OmniPack stock does not cover active reservations",
    message: `${count} active reservation coverage shortage(s). Affected SKU(s): ${affected}.`,
    channels: ["webhook"],
    payload: { count, skus, evidence },
    humanContext: {
      incidentClass: "data_integrity",
      impact: "Provider-for-sale stock is below already committed active reservations; affected orders or renewals may not be fulfillable without an explicit operations decision.",
      firstAction: `Verify the current OmniPack stock and active commitments for ${affected}. If this is planned QA, snooze the alert to the agreed expiry; otherwise correct provider stock or resolve the commitments through the owning OMS flow.`,
      urgency: "P1: page now; committed fulfillment coverage is below zero until an operator classifies or resolves the evidence.",
    },
  });
}

function pushFulfillmentHealthAlert(
  decisions: AlertDecision[],
  snapshot: ObservabilitySnapshot,
  healthStatus: "blocked_uncertain" | "local_ahead" | "provider_ahead",
  dedupeKey: string,
  title: string,
): void {
  const evidence = (snapshot.omnipack.fulfillmentHealthEvidence ?? [])
    .filter((row) => row.healthStatus === healthStatus);
  const count = {
    blocked_uncertain: snapshot.omnipack.fulfillmentHealthBlockedUncertainCount,
    local_ahead: snapshot.omnipack.fulfillmentHealthLocalAheadCount,
    provider_ahead: snapshot.omnipack.fulfillmentHealthProviderAheadCount,
  }[healthStatus] ?? evidence.length;
  if (count <= 0) return;
  decisions.push({
    dedupeKey,
    severity: "p1",
    owner: "commerce/fulfillment",
    runbookUrl: RUNBOOK_URL,
    title,
    message: `${count} OmniPack fulfillment order(s) need operator attention: ${healthStatus}.`,
    channels: ["webhook"],
    payload: {
      count,
      oldestAgeSeconds: oldestAgeSeconds(evidence),
      evidence: evidence.slice(0, 10),
    },
  });
}

function oldestAgeSeconds(evidence: Array<{ oldestAgeSeconds: number | null }>): number | null {
  const ages = evidence.map((row) => row.oldestAgeSeconds).filter((age): age is number => typeof age === "number");
  return ages.length ? Math.max(...ages) : null;
}

function pushCountAlert(
  decisions: AlertDecision[],
  count: number,
  dedupeKey: string,
  title: string,
  severity: "p0" | "p1" | "p2",
  paging: "default" | "never" = "default",
  rootAlertDedupeKey?: string,
) {
  if (count <= 0) return;
  decisions.push({
    dedupeKey,
    severity,
    owner: "commerce/fulfillment",
    runbookUrl: RUNBOOK_URL,
    title,
    message: `${title}: operations review required before OmniPack activation or retry.`,
    channels: ["webhook"],
    ...(paging === "never" ? { paging } : {}),
    payload: { count, ...(rootAlertDedupeKey ? { rootAlertDedupeKey } : {}) },
  });
}
