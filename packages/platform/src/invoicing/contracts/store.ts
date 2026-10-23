import type { InvoiceHostPorts } from "./host.js";
import type { InvoiceFacts } from "./facts.js";
import type { InvoiceIdentity, InvoiceDocumentIdentity, InvoiceProof, InvoiceUnsupported, InvoiceWriteResult, InvoiceReadbackResult } from "./provider.js";
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
 * @consumer Operator owed-duty readback.
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
  /** Never call inside a renewal money, dunning or dispatch transaction without
   * isolation: capture failure must not propagate; the sweep recovers.
   */
  captureDuty(input: { readonly requestKey: string; readonly sourceKind: "paid" | "handoff"; readonly sourceId: string; readonly orderId: string; readonly occurredAt: string; readonly evidence: { readonly settlementIntentId: string; readonly amountMinor: number; readonly currency: string } | { readonly shipmentId: string; readonly handedOverAt: string } }): Promise<{ readonly dutyId: string; readonly status: string } | InvoiceUnsupported>;
  installFacts(input: { readonly dutyId: string; readonly facts: InvoiceFacts }): Promise<{ readonly dutyId: string; readonly status: "owed" | "blocked" | "ready" | "processing" | "unknown" | "issued" | "voided" | "unsupported" | "faulted"; readonly replayed?: boolean } | InvoiceUnsupported>;
  /** Pinned split facts lease: sweep and prepare commit separately; finishing
   * requires the same token and authoritative document/fact match. No host I/O
   * under the duty lock, and unsupported never silently drops an owed duty.
   */
  sweep(limit: number): Promise<{ readonly collected: number; readonly claims: readonly { readonly dutyId: string; readonly token: string }[] } | InvoiceUnsupported>;
  prepareFacts(input: { readonly dutyId: string; readonly token: string }): Promise<{ readonly status: "owed" | "ready" | "issued" | "voided" | "unsupported" | "stale"; readonly documentId?: string; readonly requestId?: string; readonly code?: "retryable" | "legacy_facts_unproved" } | InvoiceUnsupported>;
  finishFacts(input: { readonly dutyId: string; readonly token: string; readonly result: Omit<Exclude<Awaited<ReturnType<InvoiceStorePort["prepareFacts"]>>, InvoiceUnsupported>, "status"> & { readonly status: "owed" | "ready" | "issued" | "voided" | "unsupported" } }): Promise<{ readonly dutyId: string; readonly status: "owed" | "ready" | "issued" | "voided" | "unsupported" | "faulted" | "stale" } | InvoiceUnsupported>;
  readDuties(orderId: string): Promise<InvoiceDutyReadback | InvoiceUnsupported>;
  /** Filter order before locking/limit; never lease unrelated orders then filter. */
  claim(input: { readonly limit: number; readonly visibilitySeconds: number; readonly providerRef: string; readonly orderId?: string | null }): Promise<readonly InvoiceClaim[] | InvoiceUnsupported>;
  preflight(input: { readonly claim: InvoiceClaim; readonly amountMinor: number | null; readonly currency: string | null } & (
    | { readonly status: "succeeded" | "failed" | "pending" | "unknown" | "unavailable"; readonly proof: InvoiceProof | null }
    | { readonly status: "absent"; readonly evidence: Extract<Awaited<ReturnType<InvoiceHostPorts["money"]["read"]>>, { kind: "absent" }>["evidence"] }
  )): Promise<{ readonly kind: "ready" | "blocked" | "mismatch" | "unavailable" | "stale" } | InvoiceUnsupported>;
  finish(input: { readonly claim: InvoiceClaim; readonly result: Extract<InvoiceWriteResult, { kind: "issued" }> | Extract<InvoiceReadbackResult, { kind: "found" }> }): Promise<{ readonly kind: "issued"; readonly replayed: boolean } | { readonly kind: "stale" } | InvoiceUnsupported>;
  /** Retryable requires a definite refusal (effectMayHaveSucceeded:false) or a
   * pre-I/O failure and phase before_send. Every other failure maps to unknown.
   * Native result kinds other than stale/voided map to recorded.
   */
  fail(input: { readonly claim: InvoiceClaim; readonly retrySeconds: number } & (
    | { readonly kind: "absent"; readonly evidence: Extract<InvoiceReadbackResult, { kind: "absent" }> }
    | { readonly kind: "retryable"; readonly phase: "before_send"; readonly proof: InvoiceProof | null }
    | { readonly kind: "blocked" | "unsupported" | "unknown"; readonly proof: InvoiceProof | null }
  )): Promise<{ readonly kind: "recorded" | "voided" | "stale" } | InvoiceUnsupported>;
  /** Native post-write unsupported maps to unsupported_recorded, retaining duty/replay. */
  requestReversal(input: { readonly requestKey: string; readonly orderId: string; readonly reason: "order_canceled" | "order_refunded"; readonly proof: InvoiceProof }): Promise<{ readonly kind: "missing" | "voided" | "pending_readback" | "correction_requested"; readonly dutyId?: string; readonly replayed?: boolean } | { readonly kind: "unsupported_recorded"; readonly dutyId?: string; readonly replayed?: boolean } | InvoiceUnsupported>;
  /** Existing local-only request remains distinct from fiscal issuance. */
  requestLocalDocument(input: { readonly requestKey: string; readonly orderId: string }): Promise<{ readonly kind: "requested"; readonly documentId: string; readonly replayed: boolean } | InvoiceUnsupported>;
  listClearanceTargets(limit: number): Promise<readonly { readonly documentId: string; readonly identity: InvoiceDocumentIdentity; readonly providerDocumentRef: string; readonly providerDocumentNumber: string | null; readonly state: InvoiceClearanceObservation["state"] }[] | InvoiceUnsupported>;
  /** Native maps clearance state unsupported to observation kind unsupported;
   * provider_mismatch returns InvoiceUnsupported before recording anything.
   */
  recordObservation(input: { readonly requestKey: string; readonly documentId: string; readonly eventRef: string; readonly eventKind: "clearance" | "artifacts" | "unsupported" | "provider_mismatch"; readonly identity: InvoiceDocumentIdentity; readonly providerDocumentRef: string; readonly providerDocumentNumber: string | null; readonly clearance: InvoiceClearanceObservation | null; readonly artifacts: readonly Extract<InvoiceArtifactResult, { kind: "found" }>["artifact"][]; readonly observedAt: string; readonly payloadHash: string; readonly source: "provider_api" | "provider_webhook" | "manual_reconciliation" }): Promise<{ readonly replayed: boolean } | InvoiceUnsupported>;
  /** Verify M04 binding before claiming; document rows need no M09 issue duty. */
  claimDeliveries(input: { readonly limit: number; readonly visibilitySeconds: number; readonly requireClearance: boolean; readonly orderId?: string | null }): Promise<readonly { readonly token: string; readonly generation: number; readonly identity: InvoiceDocumentIdentity; readonly providerDocumentRef: string; readonly delivery: Omit<Parameters<InvoiceDeliveryPort["send"]>[0], "filename" | "content" | "contentType"> }[] | InvoiceUnsupported>;
  /** Native uncertain settlement stores a null receipt; transport hints stay evidence. */
  settleDelivery(input: { readonly deliveryRef: string; readonly token: string; readonly generation: number; readonly result: Exclude<Awaited<ReturnType<InvoiceDeliveryPort["send"]>>, InvoiceUnsupported | { kind: "uncertain" }> | (Extract<Awaited<ReturnType<InvoiceDeliveryPort["send"]>>, { kind: "uncertain" }> & { readonly receiptRef: null }) }): Promise<{ readonly kind: "recorded" | "stale"; readonly replayed: boolean } | InvoiceUnsupported>;
}
