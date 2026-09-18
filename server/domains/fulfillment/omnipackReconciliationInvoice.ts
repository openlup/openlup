// Owner of one question - what does the accounting RPC's refusal mean for this
// run? - plus the invoice request itself, extracted from
// omnipackReconciliationWorker.ts, which sits 22 lines under a shrink-only
// 300-line cap. Incident 2026-09-09 -> 2026-09-10: a partial refund on an
// already-invoiced order moved its only payment intent out of `succeeded`, so
// the invoice RPC refused with SQLSTATE 22023 on every replay, permanently, and
// the pull path counted that one fulfilment's permanent fact as a run failure:
// 502, ledger `failed`, and a checkpoint frozen on its own page for 21+ hours -
// so two pages went unscanned and seven parcels stayed durably undelivered.
import { omnipackHandoffAccountingInvoiceIdempotencyKey } from "./omnipackAccountingInvoice.js";
import { safeReason } from "./omnipackReconciliationPayload.js";
import type {
  OmnipackReconciliationPort,
  OmnipackReconciliationResult,
} from "./omnipackReconciliationContracts.js";

// Read off the RPC's own RAISE list
// (supabase/migrations/20260716110002_accounting_handoff_operation_idempotency.sql
// :50, :58, :61, :66, :71, :76, :104): seven guards, every one
// `USING ERRCODE = '22023'`, every one permanent for the calling fulfilment. The
// outbox twin (server/domains/accounting/fulfillmentHandoffInvoiceHandler.ts:36)
// treats 23514 as permanent too; this rail deliberately does NOT. 23514 is the
// provider-immutability check, its outbox insert is ON CONFLICT DO NOTHING so
// the trigger re-fires on every replay, and the provider kind this path sends
// comes from runtime configuration - a fleet-wide fault rather than one
// fulfilment's fact, so it stays a loud run failure.
const PERMANENT_INVOICE_REFUSAL_SQLSTATE = "22023";

// The subset of 22023 RAISE identifiers meaning the aggregate or its graph was
// legitimately deleted (a cleanup orphan). Copied BY VALUE from
// server/domains/accounting/fulfillmentHandoffInvoiceHandler.ts:45-50, the
// source of truth; never imported from it. Every other 22023 -
// payment-not-succeeded, package-not-shipped, invalid-input - is a genuine
// anomaly, so its entry reads `benign: false`.
const BENIGN_INVOICE_REFUSAL_IDENTIFIERS = new Set([
  "accounting_invoice_handoff_not_found",
  "accounting_invoice_order_not_found",
  "accounting_invoice_client_not_found",
  "accounting_invoice_address_not_found",
]);

// One bad page must not grow an unbounded jsonb column; the counter keeps
// counting past the cap.
const INVOICE_REFUSAL_ENTRY_LIMIT = 10;
const INVOICE_REASON_LIMIT = 300; // fulfillmentHandoffInvoiceHandler.ts:119

export type OmnipackInvoiceRefusal = { identifier: string | null; sqlstate: string; benign: boolean };

/**
 * Permanent refusal identity, or null when this error is not one. The caught
 * value is read STRUCTURALLY, not by class: house precedent is
 * omnipackReconciliationError.ts:30-38, and `accountingInvoiceReason` reads the
 * same fields anyway, so a nominal check would answer one question two ways.
 */
export function permanentInvoiceRefusal(error: unknown): OmnipackInvoiceRefusal | null {
  const { causeCode, causeMessage } = refusalIdentity(error);
  if (causeCode !== PERMANENT_INVOICE_REFUSAL_SQLSTATE) return null;
  return {
    identifier: causeMessage ?? null,
    sqlstate: causeCode,
    benign: causeMessage !== undefined && BENIGN_INVOICE_REFUSAL_IDENTIFIERS.has(causeMessage),
  };
}

/**
 * Sibling of `safeReason`, never a replacement: it names the RPC's own RAISE
 * identifier and SQLSTATE so platform_job_runs.error says which guard refused.
 * An error carrying neither field yields exactly `safeReason(error)`.
 */
export function accountingInvoiceReason(error: unknown): string {
  const { causeCode, causeMessage } = refusalIdentity(error);
  const message = safeReason(error);
  if (causeCode === undefined && causeMessage === undefined) return message;
  const detail = causeMessage && causeMessage !== message ? `${message}: ${causeMessage}` : message;
  return (causeCode ? `${detail} (${causeCode})` : detail).slice(0, INVOICE_REASON_LIMIT);
}

export async function requestAccountingInvoice(
  port: OmnipackReconciliationPort,
  fulfillmentOrderId: string,
  result: OmnipackReconciliationResult,
): Promise<void> {
  try {
    await port.issueAccountingInvoice?.({
      idempotencyKey: omnipackHandoffAccountingInvoiceIdempotencyKey(fulfillmentOrderId),
      fulfillmentOrderId,
    });
  } catch (error) {
    const detail = accountingInvoiceReason(error);
    const refusal = permanentInvoiceRefusal(error);
    if (refusal) {
      // Counted and named under its own `..._issue_refused:` prefix, never
      // failed: invoice duty stays with accounting_shipped_without_invoice, the
      // next cycle calls the RPC again so a condition that clears heals itself,
      // and the run stays green so the checkpoint cannot starve other pages.
      // Deliberately NOT recordQuarantine - it writes inbound_provider_events
      // 'ignored', which supplies two p1 monitors (omnipackReconciliationTerminalSkip).
      result.invoiceIssueRefused += 1;
      if (result.invoiceIssueRefusals.length < INVOICE_REFUSAL_ENTRY_LIMIT) {
        result.invoiceIssueRefusals.push({ fulfillmentOrderId, ...refusal });
      }
      result.reason = result.reason ?? `omnipack_reconciliation_accounting_invoice_issue_refused:${detail}`;
      return;
    }
    result.ok = false;
    result.failures += 1;
    result.invoiceIssueFailures += 1;
    result.reason = result.reason ?? `omnipack_reconciliation_accounting_invoice_issue_failed:${detail}`;
  }
}

function refusalIdentity(error: unknown): { causeCode?: string; causeMessage?: string } {
  if (typeof error !== "object" || error === null) return {};
  const { causeCode, causeMessage } = error as { causeCode?: unknown; causeMessage?: unknown };
  return {
    causeCode: typeof causeCode === "string" ? causeCode : undefined,
    causeMessage: typeof causeMessage === "string" ? causeMessage : undefined,
  };
}
