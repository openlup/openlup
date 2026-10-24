import type { InvoiceWriteResult } from "./contracts/provider.js";

/** Durable correction identity, recovery and claim fencing from the donor worker.
 * Hosts project immutable BEFORE facts and bind a conforming recovery provider.
 * @consumer server/domains/accounting/accountingJobService.ts
 */
export async function runInvoiceCorrectionJob<Claim extends {
  outboxId: string; attemptCount: number; providerInvoiceId: string;
  correctionReason: string; payload: Record<string, unknown>;
}, Snapshot, Result extends Pick<Extract<InvoiceWriteResult, { kind: "issued" }>, "providerDocumentRef" | "providerDocumentNumber">>(input: {
  createEnabled: boolean;
  providerEnabled: boolean;
  claim(): Promise<readonly Claim[]>;
  project(claim: Claim): Snapshot;
  /** Resolve accepted/recovered receipts only; unknown is never an ACK or absence. */
  create(snapshot: Snapshot, options: {
    correctionReason: string; correctedProviderInvoiceId: string;
    correctionRef: string; recoveryLookupRequired: boolean;
  }): Promise<Result>;
  finish(claim: Claim, result: Result): Promise<unknown>;
  isClaimFenceError(error: unknown): boolean;
  fail(claim: Claim, error: unknown, retrySeconds: number): Promise<unknown>;
}) {
  if (!input.createEnabled) return skipped("create_disabled");
  if (!input.providerEnabled) return skipped("provider_disabled");
  const claims = await input.claim();
  let updated = 0;
  let failures = 0;
  for (const claim of claims) {
    try {
      const correctionRef = `accounting-correction:${claim.outboxId}`;
      if (claim.payload.providerCreateIdentity !== correctionRef) {
        throw new Error("accounting_correction_recovery_identity_missing");
      }
      const snapshot = input.project(claim);
      const result = await input.create(snapshot, {
        correctionReason: claim.correctionReason,
        correctedProviderInvoiceId: claim.providerInvoiceId,
        correctionRef,
        recoveryLookupRequired: claim.attemptCount > 1,
      });
      await input.finish(claim, result);
      updated += 1;
    } catch (error) {
      failures += 1;
      if (input.isClaimFenceError(error)) continue;
      try {
        await input.fail(claim, error, Math.min(3600, 300 * Math.max(1, claim.attemptCount)));
      } catch (failureError) {
        if (!input.isClaimFenceError(failureError)) throw failureError;
      }
    }
  }
  return { ok: failures === 0, checked: claims.length, updated, skipped: false, failures };
}
function skipped(reason: string) { return { ok: true, checked: 0, updated: 0, skipped: true, reason, failures: 0 }; }
