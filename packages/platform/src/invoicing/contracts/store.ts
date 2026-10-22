import type { InvoiceFacts } from "./facts.js";
import type { InvoiceIdentity, InvoiceProof, InvoiceUnsupported, InvoiceWriteResult, InvoiceReadbackResult } from "./provider.js";
import type { InvoiceClearanceObservation, InvoiceArtifactResult, InvoiceDeliveryPort } from "./delivery.js";
/** Native duty/lease fields map to the pinned invoicing_* fixtures. Managed hosts
 * translate their outboxId/attemptCount fences; never claim transaction equality.
 */
export interface InvoiceClaim {
  readonly dutyId: string;
  readonly documentId: string;
  readonly requestId: string;
  readonly token: string;
  readonly generation: number;
  readonly leaseUntil: string;
  readonly identity: InvoiceIdentity;
  readonly facts: InvoiceFacts;
  readonly action: "create" | "readback";
  readonly correction: { readonly before: InvoiceFacts; readonly reason: string; readonly after: { readonly totalNetMinor: 0; readonly totalTaxMinor: 0; readonly totalGrossMinor: 0 } } | null;
}
/** Exact camel-case shape returned by invoicing_duty_readback. This is not
 * payment truth's accountingRequested; empty duties never assert invoice absence.
 */
export interface InvoiceDutyReadback {
  readonly orderId: string;
  readonly captureFaults: readonly { readonly sourceId: string; readonly state: "retryable" | "faulted" | "resolved"; readonly attempts: number; readonly availableAt: string }[];
  readonly duties: readonly {
    readonly dutyId: string;
    readonly parentDutyId: string | null;
    readonly documentId: string | null;
    readonly state: "owed" | "blocked" | "claimed" | "unknown" | "issued" | "voided" | "unsupported" | "faulted";
    readonly attempts: number;
    readonly factAttempts: number;
    readonly diagnosticCode: "faulted" | "missing_facts" | "legacy_facts_unproved" | "retryable" | "blocked" | "unsupported" | "unknown" | "absent" | null;
    readonly createdAt: string;
    readonly availableAt: string;
    readonly leaseUntil: string | null;
  }[];
}
/** Every operation is one local transaction; commit before external I/O. Native
 * success atomically saves late identity and compensation; stale catch writes nothing.
 * No implementation, executor or migration is installed by these declarations.
 */
export interface InvoiceStorePort {
  captureDuty(input: { readonly requestKey: string; readonly sourceKind: "paid" | "handoff"; readonly sourceId: string; readonly orderId: string; readonly occurredAt: string; readonly evidence: { readonly settlementIntentId: string; readonly amountMinor: number; readonly currency: string } | { readonly shipmentId: string; readonly handedOverAt: string } }): Promise<{ readonly dutyId: string; readonly status: string } | InvoiceUnsupported>;
  installFacts(input: { readonly dutyId: string; readonly facts: InvoiceFacts }): Promise<{ readonly dutyId: string; readonly status: "owed" | "blocked"; readonly replayed?: boolean } | InvoiceUnsupported>;
  /** Pinned split facts lease: sweep and prepare commit separately; finishing
   * requires the same token and authoritative document/fact match. No host I/O
   * under the duty lock, and unsupported never silently drops an owed duty.
   */
  sweep(limit: number): Promise<{ readonly collected: number; readonly claims: readonly { readonly dutyId: string; readonly token: string }[] } | InvoiceUnsupported>;
  prepareFacts(input: { readonly dutyId: string; readonly token: string }): Promise<{ readonly status: "owed" | "ready" | "issued" | "voided" | "unsupported" | "stale"; readonly documentId?: string; readonly requestId?: string; readonly code?: "retryable" | "legacy_facts_unproved" } | InvoiceUnsupported>;
  finishFacts(input: { readonly dutyId: string; readonly token: string; readonly result: Exclude<Awaited<ReturnType<InvoiceStorePort["prepareFacts"]>>, InvoiceUnsupported> }): Promise<{ readonly dutyId: string; readonly status: "owed" | "ready" | "issued" | "voided" | "unsupported" | "faulted" | "stale" } | InvoiceUnsupported>;
  readDuties(orderId: string): Promise<InvoiceDutyReadback | InvoiceUnsupported>;
  /** Filter order before locking/limit; never lease unrelated orders then filter. */
  claim(input: { readonly limit: number; readonly visibilitySeconds: number; readonly providerRef: string; readonly orderId?: string | null }): Promise<readonly InvoiceClaim[] | InvoiceUnsupported>;
  preflight(input: { readonly claim: InvoiceClaim; readonly status: "succeeded" | "failed" | "pending" | "unknown" | "unavailable"; readonly amountMinor: number | null; readonly currency: string | null; readonly proof: InvoiceProof | null }): Promise<{ readonly kind: "ready" | "blocked" | "mismatch" | "unavailable" | "stale" } | InvoiceUnsupported>;
  finish(input: { readonly claim: InvoiceClaim; readonly result: Extract<InvoiceWriteResult, { kind: "issued" }> | Extract<InvoiceReadbackResult, { kind: "found" }> }): Promise<{ readonly kind: "issued"; readonly replayed: boolean } | { readonly kind: "stale" } | InvoiceUnsupported>;
  fail(input: { readonly claim: InvoiceClaim; readonly retrySeconds: number } & (
    | { readonly kind: "absent"; readonly evidence: Extract<InvoiceReadbackResult, { kind: "absent" }> }
    | { readonly kind: "retryable" | "blocked" | "unsupported" | "unknown"; readonly proof: InvoiceProof | null }
  )): Promise<{ readonly kind: "recorded" | "stale" } | InvoiceUnsupported>;
  requestReversal(input: { readonly requestKey: string; readonly orderId: string; readonly reason: "order_canceled" | "order_refunded"; readonly proof: InvoiceProof }): Promise<{ readonly kind: "missing" | "voided" | "pending_readback" | "correction_requested"; readonly dutyId?: string; readonly replayed?: boolean } | InvoiceUnsupported>;
  /** Existing local-only request remains distinct from fiscal issuance. */
  requestLocalDocument(input: { readonly requestKey: string; readonly orderId: string }): Promise<{ readonly kind: "requested"; readonly documentId: string; readonly replayed: boolean } | InvoiceUnsupported>;
  listClearanceTargets(limit: number): Promise<readonly { readonly documentId: string; readonly identity: InvoiceIdentity; readonly providerDocumentRef: string; readonly providerDocumentNumber: string | null; readonly state: InvoiceClearanceObservation["state"] }[] | InvoiceUnsupported>;
  recordObservation(input: { readonly requestKey: string; readonly documentId: string; readonly eventRef: string; readonly eventKind: "clearance" | "artifacts" | "provider_mismatch"; readonly identity: InvoiceIdentity; readonly providerDocumentRef: string; readonly providerDocumentNumber: string | null; readonly clearance: InvoiceClearanceObservation | null; readonly artifacts: readonly Extract<InvoiceArtifactResult, { kind: "found" }>["artifact"][]; readonly observedAt: string; readonly payloadHash: string; readonly source: "provider_api" | "provider_webhook" | "manual_reconciliation" }): Promise<{ readonly replayed: boolean } | InvoiceUnsupported>;
  claimDeliveries(input: { readonly limit: number; readonly visibilitySeconds: number; readonly requireClearance: boolean; readonly orderId?: string | null }): Promise<readonly { readonly token: string; readonly generation: number; readonly identity: InvoiceIdentity; readonly providerDocumentRef: string; readonly delivery: Omit<Parameters<InvoiceDeliveryPort["send"]>[0], "filename" | "content" | "contentType"> }[] | InvoiceUnsupported>;
  settleDelivery(input: { readonly deliveryRef: string; readonly token: string; readonly generation: number; readonly result: Awaited<ReturnType<InvoiceDeliveryPort["send"]>> }): Promise<{ readonly kind: "recorded" | "stale"; readonly replayed: boolean } | InvoiceUnsupported>;
}
