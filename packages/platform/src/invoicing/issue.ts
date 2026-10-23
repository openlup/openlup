import type { InvoiceWriteResult } from "./contracts/provider.js";

/** Donor issue sequencing over explicit compatibility callbacks. No transaction
 * spans a callback; hosts bind their existing claim/preflight/finalizer contracts.
 * @consumer server/domains/accounting/accountingJobService.ts
 */
export async function runInvoiceIssueJob<Claim extends { attemptCount: number }, Snapshot, Evidence, Result extends Pick<Extract<InvoiceWriteResult, { kind: "issued" }>, "providerDocumentRef" | "providerDocumentNumber">>(input: {
  createEnabled: boolean;
  providerEnabled: boolean;
  claim(): Promise<readonly Claim[]>;
  localPreflight(claim: Claim): Promise<boolean>;
  project(claim: Claim): Snapshot;
  blockMapper(claim: Claim, code: string, error: unknown): Promise<unknown>;
  readPayment(claim: Claim): Promise<Evidence>;
  freshPreflight(claim: Claim, evidence: Evidence): Promise<boolean>;
  /** Resolve only accepted/recovered document receipts; unknown/absent is not an ACK. */
  create(snapshot: Snapshot, options: { recoveryLookupRequired: boolean }): Promise<Result>;
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
      if (!await input.localPreflight(claim)) {
        failures += 1;
        continue;
      }
      let snapshot: Snapshot;
      try {
        snapshot = input.project(claim);
      } catch (error) {
        const canonicalCode = canonicalMapperErrorCode(error);
        if (!canonicalCode) throw error;
        await input.blockMapper(claim, canonicalCode, error);
        failures += 1;
        continue;
      }
      const providerEvidence = await input.readPayment(claim);
      if (!await input.freshPreflight(claim, providerEvidence)) {
        failures += 1;
        continue;
      }
      const result = await input.create(snapshot, { recoveryLookupRequired: claim.attemptCount > 1 });
      await input.finish(claim, result);
      updated += 1;
    } catch (error) {
      failures += 1;
      if (input.isClaimFenceError(error)) continue;
      await input.fail(claim, error, Math.min(3600, 300 * Math.max(1, claim.attemptCount)));
    }
  }
  return { ok: failures === 0, checked: claims.length, updated, skipped: false, failures };
}
function canonicalMapperErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const match = /\b(accounting_invoice_canonical_[a-z0-9_]+)/.exec(error.message);
  return match?.[1] ?? null;
}
function skipped(reason: string) { return { ok: true, checked: 0, updated: 0, skipped: true, reason, failures: 0 }; }
