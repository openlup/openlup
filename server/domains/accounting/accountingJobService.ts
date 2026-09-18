import type {
  AccountingDocumentProviderPort,
  AccountingInvoiceRuntimePort,
} from "../../../src/domains/accounting/ports.js";
import { routeInvoiceByTaxId } from "../../../src/domains/accounting/invoiceContracts.js";
import { syncAcceptedKsefDocuments } from "./accountingDocumentSync.js";
import {
  assertProviderInvoiceTaxIdSafe,
  mapCorrectionClaimToProviderSnapshot,
  mapInvoiceClaimToProviderSnapshot,
  sanitizeAccountingError,
} from "./accountingProviderSnapshot.js";
import type { AccountingRuntimeConfig } from "./accountingRuntimeConfig.js";
import {
  readAccountingPaymentProviderEvidence,
  type AccountingPaymentProviderReadbackRegistry,
} from "./accountingPaymentReadback.js";

export type AccountingJobResult = {
  ok: boolean;
  checked: number;
  updated: number;
  skipped: boolean;
  reason?: string;
  failures: number;
};

export { runAccountingInvoiceDeliveryJob } from "./accountingInvoiceDeliveryJob.js";

export async function runAccountingInvoiceIssueJob({
  port,
  provider,
  config,
  env,
  limit = 10,
  orderId = null,
  paymentProviders = {},
}: {
  port: AccountingInvoiceRuntimePort;
  provider: AccountingDocumentProviderPort | null;
  config: AccountingRuntimeConfig;
  env: Record<string, string | undefined>;
  limit?: number;
  orderId?: string | null;
  paymentProviders?: AccountingPaymentProviderReadbackRegistry;
}): Promise<AccountingJobResult> {
  if (!config.createEnabled) return skipped("create_disabled");
  if (!provider) return skipped("provider_disabled");

  const claims = await port.claimInvoiceIssues(limit, { orderId });
  let updated = 0;
  let failures = 0;

  for (const claim of claims) {
    try {
      const localPreflight = await port.preflightInvoiceIssuePayment({
        invoiceId: claim.invoice.id,
        outboxId: claim.outboxId,
        claimAttemptCount: claim.attemptCount,
        providerStatus: "unavailable",
        providerAmountCents: null,
        providerCurrency: null,
        providerEvidence: { source: "local_canonical_snapshot" },
      });
      if (!localPreflight.ok) {
        failures += 1;
        continue;
      }

      let snapshot;
      try {
        snapshot = mapInvoiceClaimToProviderSnapshot(claim, env);
        // The opt-in: this deployment's jurisdiction module, named here at the
        // composition root rather than defaulted to inside the policy. The
        // policy's own default refuses, so forgetting this blocks documents.
        assertProviderInvoiceTaxIdSafe(snapshot, routeInvoiceByTaxId);
      } catch (error) {
        const canonicalCode = canonicalMapperErrorCode(error);
        if (!canonicalCode) throw error;
        await port.blockInvoiceIssueCanonicalMapper({
          invoiceId: claim.invoice.id,
          outboxId: claim.outboxId,
          claimAttemptCount: claim.attemptCount,
          code: canonicalCode,
          evidence: { stage: "independent_mapper", message: error instanceof Error ? error.message : String(error) },
        });
        failures += 1;
        continue;
      }

      const providerEvidence = await readAccountingPaymentProviderEvidence(claim, paymentProviders);
      const preflight = await port.preflightInvoiceIssuePayment({
        invoiceId: claim.invoice.id,
        outboxId: claim.outboxId,
        claimAttemptCount: claim.attemptCount,
        providerStatus: providerEvidence.providerStatus,
        providerAmountCents: providerEvidence.providerAmountCents,
        providerCurrency: providerEvidence.providerCurrency,
        providerEvidence: providerEvidence.providerEvidence,
      });
      if (!preflight.ok) {
        // The preflight RPC atomically blocks the invoice and records the
        // stable non-retryable code on the outbox. Do not pass this through the
        // generic retry path, which would overwrite that evidence and schedule
        // a misleading retry.
        failures += 1;
        continue;
      }
      const result = await provider.createInvoice(snapshot, {
        recoveryLookupRequired: claim.attemptCount > 1,
      });
      await port.markInvoiceIssueSucceeded({
        outboxId: claim.outboxId,
        claimAttemptCount: claim.attemptCount,
        providerInvoiceId: result.providerInvoiceId,
        providerInvoiceNumber: result.providerInvoiceNumber,
        providerRaw: result.raw,
      });
      updated += 1;
    } catch (error) {
      failures += 1;
      if (isInvoiceIssueClaimFenceError(error)) {
        continue;
      }
      await port.markInvoiceIssueFailed({
        outboxId: claim.outboxId,
        claimAttemptCount: claim.attemptCount,
        error: sanitizeAccountingError(error),
        retrySeconds: retrySeconds(claim.attemptCount),
      });
    }
  }

  return { ok: failures === 0, checked: claims.length, updated, skipped: false, failures };
}

function isInvoiceIssueClaimFenceError(error: unknown): boolean {
  const causeCode = typeof error === "object" && error !== null && "causeCode" in error
    ? (error as { causeCode?: unknown }).causeCode : null;
  return typeof causeCode === "string" && causeCode.startsWith("accounting_invoice_issue_claim_");
}

function canonicalMapperErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const match = /\b(accounting_invoice_canonical_[a-z0-9_]+)/.exec(error.message);
  return match?.[1] ?? null;
}

export async function runAccountingInvoiceCorrectionJob({
  port,
  provider,
  config,
  env,
  limit = 10,
}: {
  port: AccountingInvoiceRuntimePort;
  provider: AccountingDocumentProviderPort | null;
  config: AccountingRuntimeConfig;
  env: Record<string, string | undefined>;
  limit?: number;
}): Promise<AccountingJobResult> {
  if (!config.createEnabled) return skipped("create_disabled");
  if (!provider) return skipped("provider_disabled");

  const claims = await port.claimInvoiceCorrections(limit);
  let updated = 0;
  let failures = 0;
  for (const claim of claims) {
    try {
      const snapshot = mapCorrectionClaimToProviderSnapshot(claim, env);
      const result = await provider.createFullCorrection(snapshot, {
        correctionReason: claim.correctionReason,
        correctedProviderInvoiceId: claim.providerInvoiceId,
      });
      await port.markInvoiceCorrectionSucceeded({
        outboxId: claim.outboxId,
        providerInvoiceId: result.providerInvoiceId,
        providerInvoiceNumber: result.providerInvoiceNumber,
        providerRaw: result.raw,
      });
      updated += 1;
    } catch (error) {
      failures += 1;
      await port.markInvoiceCorrectionFailed({
        outboxId: claim.outboxId,
        error: sanitizeAccountingError(error),
        retrySeconds: retrySeconds(claim.attemptCount),
      });
    }
  }

  return { ok: failures === 0, checked: claims.length, updated, skipped: false, failures };
}

export async function runAccountingKsefStatusJob({
  port,
  provider,
  config,
  limit = 25,
}: {
  port: AccountingInvoiceRuntimePort;
  provider: AccountingDocumentProviderPort | null;
  config: AccountingRuntimeConfig;
  limit?: number;
}): Promise<AccountingJobResult> {
  if (!config.ksefPollEnabled) return skipped("ksef_poll_disabled");
  if (!provider) return skipped("provider_disabled");
  if (!provider.getInvoiceKsefStatus) return skipped("provider_ksef_status_unsupported");

  const targets = await port.listKsefPollTargets(limit);
  let updated = 0;
  let failures = 0;
  for (const target of targets) {
    try {
      const status = await provider.getInvoiceKsefStatus(target.providerInvoiceId);
      await port.recordKsefStatus({
        invoiceId: target.invoiceId,
        ksefNumber: status.ksefNumber,
        ksefStatus: status.ksefStatus,
        payload: status.raw,
      });
      const downloadKsefAttachment = provider.downloadKsefAttachment;
      if (status.ksefStatus === "accepted" && downloadKsefAttachment) {
        await syncAcceptedKsefDocuments({
          port,
          provider: {
            downloadInvoicePdf: provider.downloadInvoicePdf.bind(provider),
            downloadKsefAttachment: downloadKsefAttachment.bind(provider),
          },
          target,
          status: { ...status, ksefStatus: "accepted" },
        });
      }
      updated += 1;
    } catch {
      failures += 1;
    }
  }
  return { ok: failures === 0, checked: targets.length, updated, skipped: false, failures };
}

function retrySeconds(attemptCount: number): number { return Math.min(3600, 300 * Math.max(1, attemptCount)); }

function skipped(reason: string): AccountingJobResult { return { ok: true, checked: 0, updated: 0, skipped: true, reason, failures: 0 }; }
