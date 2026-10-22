import type { FulfillmentObservation, FulfillmentObservationPagePort, FulfillmentReconciliationObservation, FulfillmentOperationError } from "./contracts/index.js";
import { durableStrings, localFailureReason, safeDiagnosticCode, operationError } from "./dispatchProjection.js";
import { applyFulfillmentObservationEffects } from "./fulfillmentObservationEffects.js";
import { observationStatusPolicy, projectObservation, projectPollEvidence, projectTrackingReference } from "./observationProjection.js";
import { quarantineReconciliationStateConflict } from "./providerReconciliationError.js";
import { isOffTrackFulfillmentStatus } from "./providerReconciliationTerminalSkip.js";
import { normalizeReconciliationTimestamp } from "./providerReconciliationTimestamp.js";
import { enrichTrackingReference, trackingReferenceComplete, uniqueTrackingReferences } from "./providerTrackingReferences.js";

type Ingress = Parameters<typeof import("./verifiedIngress.js").verifyAndNormalizeFulfillmentObservation>[0];
type DispatchRef = NonNullable<Awaited<ReturnType<Ingress["lifecycle"]["findDispatchRef"]>>>;
type PollEvidence = Pick<FulfillmentObservation, "correlation" | "eventKey" | "providerStatus" | "diagnostics"> | FulfillmentObservation;
export interface ReconciliationResult {
  ok: boolean; checked: number; updated: number; trackingRefs: number; quarantined: number;
  stateConflicts: number; exceptions: number; stale: number; offTrackSkips: number; replayed: number;
  redactedFieldCount?: number; failures: number; invoiceIssueFailures: number; invoiceIssueRefused: number;
  invoiceIssueRefusals: { fulfillmentRef: string; identifier: string | null; sqlstate: string; benign: boolean }[];
  providerCalls: number; readBacks: number; skipped: boolean; reason?: string; providerError?: FulfillmentOperationError;
}

export async function reconcileFulfillmentObservations(input: {
  /** Adapter/host maps the private page into typed readback, preserving unknowns. */
  readPage(input: { page: number; size: number }): Promise<readonly FulfillmentReconciliationObservation[]>;
  batchSize: number; page?: number;
  localPersistence: {
    /** G17: local persisted chronology, never inferred from dispatch or provider state. */
    readLocalFulfillmentStatus(ref: string): Promise<string | null>;
    latestStatusOccurredAt(ref: string): Promise<string | null>;
    readHandedOverAt(ref: string): Promise<string | null>;
  };
  lifecycle: Pick<Ingress["lifecycle"], "recordStatusEvidence" | "effects" | "keys"> & {
    findDispatchRef(evidence: PollEvidence): Promise<DispatchRef | null>;
    acknowledgeDispatchAcceptance(ref: DispatchRef, evidence: PollEvidence): Promise<void>;
    recordQuarantine(observation: PollEvidence | null, reason: "missing_correlation" | "missing_external_ref" | "unknown_status" | "state_conflict", detail?: "fulfillment_not_found" | "stock_consumed_requires_label"): Promise<{ replayed: boolean }>;
    recordProviderException(ref: DispatchRef, observation: FulfillmentObservation): Promise<{ replayed: boolean }>;
    readDeliveryCarrier(ref: string): Promise<{ carrierRef: string | null; serviceRef: string | null } | null>;
    trackingCodecs: Parameters<typeof enrichTrackingReference>[2];
    issueAccountingInvoice?(ref: string): Promise<void>;
    /** Private RPC decoding retains permanent/benign distinction and safe refusal identity. */
    invoiceFailure(error: unknown): { permanent: boolean; identifier: string | null; sqlstate: string | null; benign: boolean };
    classifyStateConflict(error: unknown): "fulfillment_not_found" | "stock_consumed_requires_label" | null;
  };
}): Promise<ReconciliationResult> {
  const privacy = durableStrings();
  const failure = (stage: string, error: unknown) => localFailureReason(stage, error, privacy);
  const result: ReconciliationResult = {
    ok: true, checked: 0, updated: 0, trackingRefs: 0, quarantined: 0, stateConflicts: 0, exceptions: 0,
    stale: 0, offTrackSkips: 0, replayed: 0, failures: 0, invoiceIssueFailures: 0, invoiceIssueRefused: 0,
    invoiceIssueRefusals: [], providerCalls: 0, readBacks: 0, skipped: false,
  };
  const page = await input.readPage({ page: input.page ?? 0, size: input.batchSize });
  result.providerCalls += 1;
  result.checked = page.length;
  const quarantine = async (observation: PollEvidence | null, reason: Parameters<typeof input.lifecycle.recordQuarantine>[1]) => {
    const evidence = await input.lifecycle.recordQuarantine(observation, reason);
    if (evidence.replayed) result.replayed += 1;
    result.quarantined += evidence.replayed ? 0 : 1;
  };
  const invoice = async (ref: string) => {
    try { await input.lifecycle.issueAccountingInvoice?.(ref); }
    catch (error) {
      const refusal = input.lifecycle.invoiceFailure(error);
      if (refusal.permanent) {
        result.invoiceIssueRefused += 1;
        if (result.invoiceIssueRefusals.length < 10) result.invoiceIssueRefusals.push({ fulfillmentRef: ref,
          identifier: privacy.token(refusal.identifier, safeDiagnosticCode), sqlstate: privacy.token(refusal.sqlstate, safeDiagnosticCode) ?? "22023", benign: refusal.benign });
        result.reason ??= failure("reconciliation_invoice_issue_refused", { causeMessage: refusal.identifier, causeCode: refusal.sqlstate, message: error instanceof Error ? error.message : undefined });
        return;
      }
      result.ok = false; result.failures += 1; result.invoiceIssueFailures += 1;
      result.reason ??= failure("reconciliation_invoice_issue_failed", error);
    }
  };
  for (const readback of page) {
    let observation: FulfillmentObservation | null = null;
    try {
      if (readback.kind === "unknown") {
        result.ok = false; result.failures += 1; result.reason ??= "fulfillment_reconciliation_provider_read_failed";
        continue;
      }
      if (readback.kind === "unmapped") {
        // An unknown primary status still correlates/ACKs, but an off-track row
        // must never trade a benign skip for a quarantine alarm.
        const evidence = projectPollEvidence(readback.evidence);
        const ref = await input.lifecycle.findDispatchRef(evidence);
        if (!ref) { await quarantine(evidence, "missing_correlation"); continue; }
        const localState = await input.localPersistence.readLocalFulfillmentStatus(ref.fulfillmentRef);
        if (isOffTrackFulfillmentStatus(localState)) { result.offTrackSkips += 1; continue; }
        if (!(readback.externalRef?.trim() || ref.externalRef?.trim())) { await quarantine(evidence, "missing_external_ref"); continue; }
        await input.lifecycle.acknowledgeDispatchAcceptance(ref, evidence);
        await quarantine(evidence, "unknown_status");
        continue;
      }
      if (readback.kind !== "found") {
        // Neither unsupported nor a provider absence is a local transition.
        continue;
      }
      observation = projectObservation(readback.observation, input.lifecycle.trackingCodecs.approveTrackingUrl);
      const ref = await input.lifecycle.findDispatchRef(observation);
      if (!ref) { await quarantine(observation, "missing_correlation"); continue; }
      const localState = await input.localPersistence.readLocalFulfillmentStatus(ref.fulfillmentRef);
      const offTrack = isOffTrackFulfillmentStatus(localState);
      if (offTrack) result.offTrackSkips += 1;
      if (!offTrack) {
        if (!(readback.externalRef.trim() || ref.externalRef?.trim())) { await quarantine(observation, "missing_external_ref"); continue; }
        await input.lifecycle.acknowledgeDispatchAcceptance(ref, observation);
      }
      const occurredAt = normalizeReconciliationTimestamp(readback.updatedAt);
      const localStatus = observation.fact.canonicalStatus;
      const latest = await input.localPersistence.latestStatusOccurredAt(ref.fulfillmentRef);
      if (latest && occurredAt && Date.parse(occurredAt) < Date.parse(latest)) {
        result.stale += 1;
        if (!offTrack && input.lifecycle.issueAccountingInvoice && await input.localPersistence.readHandedOverAt(ref.fulfillmentRef)) await invoice(ref.fulfillmentRef);
        continue;
      }
      // The normalized fact carries the same nullable occurrence used by dedupe.
      observation = { ...observation, fact: { ...observation.fact, occurredAt } };
      const status = await input.lifecycle.recordStatusEvidence(ref, observation);
      if (status.replayed) result.replayed += 1;
      if (offTrack) continue;
      result.updated += status.replayed ? 0 : 1;
      if (localStatus === "exception") {
        const exception = await input.lifecycle.recordProviderException(ref, observation);
        if (exception.replayed) result.replayed += 1;
        result.exceptions += exception.replayed ? 0 : 1;
        if (input.lifecycle.issueAccountingInvoice && await input.localPersistence.readHandedOverAt(ref.fulfillmentRef)) await invoice(ref.fulfillmentRef);
        continue;
      }
      const trackingRefs = [];
      if (observationStatusPolicy.handsOver(localStatus)) {
        let carrier: Awaited<ReturnType<typeof input.lifecycle.readDeliveryCarrier>> | undefined;
        for (const tracking of uniqueTrackingReferences(observation.trackingRefs)) {
          if (!trackingReferenceComplete(tracking) && carrier === undefined) carrier = await input.lifecycle.readDeliveryCarrier(ref.fulfillmentRef);
          const codecs = input.lifecycle.trackingCodecs;
          const candidate = enrichTrackingReference(tracking, carrier ?? null, codecs);
          const enriched = projectTrackingReference(candidate, privacy,
            url => codecs.approveTrackingUrl?.(url) === true || url === codecs.publicUrl(candidate.carrierRef, candidate.trackingNumber));
          trackingRefs.push({ trackingNumber: enriched.trackingNumber, trackingUrl: enriched.publicUrl, carrierKind: enriched.carrierRef, service: enriched.serviceRef });
        }
      }
      await applyFulfillmentObservationEffects({
        port: input.lifecycle.effects, localStatus, ids: { orderId: ref.orderRef, fulfillmentOrderId: ref.fulfillmentRef }, observation,
        trackingRefs, stockIdempotencyKey: input.lifecycle.keys.stock(ref.fulfillmentRef), handoffIdempotencyKey: input.lifecycle.keys.handoff(ref.fulfillmentRef),
        trackingIdempotencyKey: number => input.lifecycle.keys.tracking(observation!.eventKey, number),
        issueAccountingInvoice: input.lifecycle.issueAccountingInvoice ? () => invoice(ref.fulfillmentRef) : undefined,
        onReplayed: () => { result.replayed += 1; },
        onTrackingRecorded: tracking => {
          if (tracking.replayed) result.replayed += 1;
          if (tracking.readBack) result.readBacks += 1;
          result.trackingRefs += tracking.replayed ? 0 : 1;
        },
      }, observationStatusPolicy);
    } catch (caught) {
      const error = observation ? await quarantineReconciliationStateConflict(caught, observation,
        input.lifecycle.classifyStateConflict, input.lifecycle.recordQuarantine, result) : caught;
      if (error === null) continue;
      result.ok = false; result.failures += 1; result.reason ??= failure("reconciliation_local_operation_failed", error);
    }
  }
  return { ...result, ...(privacy.redactedFieldCount ? { redactedFieldCount: privacy.redactedFieldCount } : {}) };
}


/** Host owns scheduling, HTTP and durable job-ledger writes. This operation only projects them. */
export async function runFulfillmentReconciliationPage(input: Omit<Parameters<typeof reconcileFulfillmentObservations>[0], "readPage" | "batchSize" | "page"> & {
  provider: FulfillmentObservationPagePort; pageSize: number; checkpoint: unknown;
}) {
  if (!Number.isSafeInteger(input.pageSize) || input.pageSize <= 0) throw new Error("reconciliation_page_size_invalid");
  const isPage = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  const checkpoint = input.checkpoint as { reconciliationPagination?: { version?: unknown; pageSize?: unknown; page?: unknown; nextPage?: unknown } } | null;
  const saved = checkpoint?.reconciliationPagination;
  const page = saved?.version === 1 && saved.pageSize === input.pageSize && isPage(saved.page) && isPage(saved.nextPage)
    && (saved.nextPage === 0 || saved.nextPage === saved.page || saved.page < Number.MAX_SAFE_INTEGER && saved.nextPage === saved.page + 1) ? saved.nextPage : 0;
  const privacy = durableStrings();
  let result: ReconciliationResult;
  let pageRead = false;
  const empty = (): ReconciliationResult => ({ ok: true, checked: 0, updated: 0, trackingRefs: 0, quarantined: 0, stateConflicts: 0, exceptions: 0,
    stale: 0, offTrackSkips: 0, replayed: 0, failures: 0, invoiceIssueFailures: 0, invoiceIssueRefused: 0, invoiceIssueRefusals: [], providerCalls: 1, readBacks: 0, skipped: false });
  try {
    const response = await input.provider.readPage({ page, size: input.pageSize });
    if (response.kind === "page_exhausted") result = { ...empty(), reason: "page_exhausted" };
    else if (response.kind === "failed") {
      const providerError = response.error ? operationError(response.error) : undefined;
      result = { ...empty(), ok: false, failures: 1, ...(providerError ? { providerError } : {}),
        reason: providerError?.code ?? privacy.token(response.refusal.reason) ?? "redacted" };
    }
    else {
      pageRead = true;
      result = await reconcileFulfillmentObservations({ ...input, batchSize: input.pageSize, page, readPage: async () => response.rows });
    }
  } catch (error) {
    result = { ...empty(), ok: false, failures: 1, reason: localFailureReason(pageRead ? "reconciliation_page_failed" : "reconciliation_provider_read_failed", error, privacy) };
  }
  if (privacy.redactedFieldCount) result.redactedFieldCount = (result.redactedFieldCount ?? 0) + privacy.redactedFieldCount;
  // A pre-traversal abort must not skip a page. Item failures return normally.
  const nextPage = pageRead && result.checked === 0 && !result.ok ? page
    : result.checked === input.pageSize && page < Number.MAX_SAFE_INTEGER ? page + 1 : 0;
  return { status: result.ok ? 200 as const : 502 as const, ledgerStatus: result.ok ? "succeeded" as const : "failed" as const, result,
    metadata: { reconciliationPagination: { version: 1, page, pageSize: input.pageSize, nextPage } } };
}
