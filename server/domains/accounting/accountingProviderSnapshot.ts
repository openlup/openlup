import { createHash } from "node:crypto";
import type {
  AccountingCorrectionOutboxTarget,
  AccountingDocumentProviderInvoiceSnapshot,
  ClaimedAccountingInvoiceIssue,
} from "../../../src/domains/accounting/ports.js";
import {
  neutralTaxIdRouting,
  type AccountingSellerConfig,
  readAccountingSellerConfig,
  type TaxIdRoutingPort,
} from "../../../src/domains/accounting/invoiceContracts.js";
import { APP_DEFAULT_SELLER } from "../../../src/lib/brand/appBrand.js";
import { mapInvoiceClaimToProviderSnapshot as mapIssueSnapshot } from "@openlup/platform/invoicing";

export type AccountingProviderInvoiceSnapshot = AccountingDocumentProviderInvoiceSnapshot;

export function mapInvoiceClaimToProviderSnapshot(
  claim: ClaimedAccountingInvoiceIssue,
  env: Record<string, string | undefined>,
): AccountingProviderInvoiceSnapshot {
  return mapIssueSnapshot({
    orderRef: claim.invoice.orderRef,
    issueDate: dateOnly(claim.invoice.packageShippedAt ?? claim.invoice.paymentCompletedAt),
    sellDate: dateOnly(claim.invoice.paymentCompletedAt),
    currency: claim.invoice.currency,
    seller: claimedSeller(claim) ?? readAccountingSellerConfig(env, APP_DEFAULT_SELLER),
    buyerSnapshot: claim.invoice.buyerSnapshot,
    documentKind: claim.invoice.documentKind === "b2b_vat" ? "b2b_vat" as const : "b2c_named" as const,
    governmentClearanceRequired: claim.invoice.ksefRequired,
    payment: {
      provider: textValue(claim.invoice.metadata.paymentProvider),
      providerPaymentId: claim.invoice.providerPaymentId,
      paymentCompletedAt: claim.invoice.paymentCompletedAt ?? "",
    },
    linesSnapshot: claim.invoice.linesSnapshot,
    totalGrossMinor: claim.invoice.totalGrossCents,
    totalNetMinor: claim.invoice.totalNetCents,
    orderMoney: claim.invoice.orderMoney,
  }, { defaultLineLabel: "Product", defaultBuyerLabel: "Customer", deliveryLabel: "Dostawa", defaultTaxRate: "8" });
}

// Pro-rata discount allocation in integer minor units over the item portion
// of the charge (charged total minus any recognized delivery residual).
// Largest-remainder rounding guarantees the allocated totals sum exactly to
// the target. Fails closed on any shape it cannot make exact: a charge above
// the line totals (e.g. shipping the order header cannot account for) must
// never be smeared into item prices, and a discount cannot be spread over
// zero-value lines.
export function mapCorrectionClaimToProviderSnapshot(
  claim: AccountingCorrectionOutboxTarget,
  env: Record<string, string | undefined>,
): AccountingProviderInvoiceSnapshot {
  return {
    orderRef: claim.invoice.orderRef,
    issueDate: dateOnly(new Date().toISOString()),
    sellDate: dateOnly(new Date().toISOString()),
    currency: claim.invoice.currency,
    seller: claimedSeller(claim) ?? readAccountingSellerConfig(env, APP_DEFAULT_SELLER),
    buyer: {
      name: textValue(claim.invoice.buyerSnapshot.name) ?? "Customer",
      email: textValue(claim.invoice.buyerSnapshot.email),
      taxId: textValue(claim.invoice.buyerSnapshot.taxId),
      companyName: textValue(claim.invoice.buyerSnapshot.companyName),
      address: mapCorrectionBuyerAddress(claim.invoice.buyerSnapshot.address),
    },
    documentKind: claim.invoice.documentKind === "b2b_vat" ? "b2b_vat" : "b2c_named",
    governmentClearanceRequired: claim.invoice.ksefRequired,
    lines: claim.invoice.linesSnapshot.map(mapCorrectionLineSnapshot),
  };
}

// The correction document mirrors the issued document's buyer; the full
// street (line1 + line2) rides on the single street field Fakturownia
// accepts (verified against the live 2026-07-13 manual correction).
function mapCorrectionBuyerAddress(value: unknown): AccountingProviderInvoiceSnapshot["buyer"]["address"] {
  const address = isRecord(value) ? value : {};
  const street = [textValue(address.line1), textValue(address.line2)].filter(Boolean).join(" ");
  return {
    line1: street ? street : null,
    postalCode: textValue(address.postalCode),
    city: textValue(address.city),
    country: textValue(address.country),
  };
}

/**
 * Refuses a business or clearance-bound document whose buyer tax id the
 * configured routing module will not vouch for.
 *
 * The router is a parameter with a **neutral default that refuses**, not a
 * hard-wired national rule. A jurisdiction module is opted into at the
 * composition root — `accountingJobService` names this deployment's — so a
 * caller that has not chosen one blocks the document instead of sending an
 * unverified tax id to a fiscal provider. The safe direction for a missing
 * routing policy is fewer documents, not less checking.
 */
export function assertProviderInvoiceTaxIdSafe(
  snapshot: AccountingProviderInvoiceSnapshot,
  routeTaxId: TaxIdRoutingPort = neutralTaxIdRouting,
): void {
  const wantsB2bOrGov =
    snapshot.documentKind === "b2b_vat" || snapshot.governmentClearanceRequired === true;
  if (!wantsB2bOrGov) return;
  const routing = routeTaxId(snapshot.buyer.taxId);
  if (
    !routing.ok || routing.documentKind !== "b2b_vat"
    || routing.governmentClearanceRequired !== true
  ) {
    throw new Error("fakturownia_b2b_invoice_invalid_tax_id");
  }
  snapshot.buyer.taxId = routing.normalizedTaxId;
}

export function sanitizeAccountingError(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    message: message.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]").slice(0, 180),
  };
}

// Correction lines carry the amounts of the document being corrected: the
// provider adapter mirrors them into correction_before and hardcodes the
// zero-out (correction_after = 0), so zeroed lines here would emit a 0→0
// no-op correction. The correction flow is manual by design and stays
// untouched by issue-path reconciliation.
function mapCorrectionLineSnapshot(value: unknown) {
  const { name, quantity, totalGrossMinor, vatRate } = parseLineSnapshot(value);
  const totalNetMinor = estimateNetMinor(totalGrossMinor, vatRate);
  return {
    name,
    quantity,
    unitGrossMinor: Math.round(totalGrossMinor / quantity),
    unitNetMinor: Math.round(totalNetMinor / quantity),
    totalGrossMinor,
    totalNetMinor,
    vatRate,
  };
}

function parseLineSnapshot(value: unknown): {
  name: string;
  quantity: number;
  totalGrossMinor: number;
  vatRate: string;
} {
  const row = isRecord(value) ? value : {};
  const quantity = numberValue(row.quantity) || 1;
  const vatRate = textValue(row.vatRate) ?? "8";
  // Legacy (pre-#1693) lines_snapshot rows carry only the per-unit
  // unitGrossMinor, so the line total is unit price times quantity.
  const unitGrossMinor = numberValue(row.unitGrossMinor);
  const totalGrossMinor = numberValue(row.totalGrossMinor) ??
    (unitGrossMinor === null ? 0 : unitGrossMinor * quantity);
  return {
    name: textValue(row.name) ?? "Product",
    quantity,
    totalGrossMinor,
    vatRate,
  };
}

function estimateNetMinor(grossMinor: number, vatRate: string): number {
  const rate = Number(vatRate.replace(",", "."));
  return Number.isFinite(rate) ? Math.round(grossMinor / (1 + rate / 100)) : grossMinor;
}

function dateOnly(value: string | null): string {
  return value ? value.slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Host-owned selection; changes to any selected field yield a distinct revision. */
export function readAccountingSellerRevision(env: Record<string, string | undefined>) {
  const seller = readAccountingSellerConfig(env, APP_DEFAULT_SELLER);
  return { kind: "found" as const, seller, revisionRef: createHash("sha256").update(JSON.stringify(seller)).digest("hex") };
}
function claimedSeller(claim: object): AccountingSellerConfig | null {
  const value = claim as { seller?: AccountingSellerConfig; sellerRevision?: string; sellerMode?: string };
  if (value.sellerMode === "frozen") {
    if (!value.seller || !value.sellerRevision) throw new Error("accounting_claim_seller_missing");
    return value.seller;
  }
  // Legacy obligations keep the execution-time host read, even if the wrapper
  // returned an earlier selection alongside the claim.
  return null;
}
