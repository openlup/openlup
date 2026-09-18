import { isValidPolishNip, normalizePolishNip } from "../../../src/lib/schemas/fields/taxId.js";
import { documentNotes, quantityUnit } from "../accounting/invoicePresentation.js";
import { settlementFields } from "../accounting/invoiceSettlement.js";

// Activation gating lives in ./activationGate.ts, re-exported for callers.
export {
  readFakturowniaDemoPreviewGate,
  readFakturowniaReadinessConfig,
} from "#accounting-provider-activation";

// Mirrors the neutral port by hand: the provider-infra boundary bars domain imports.
export interface FakturowniaSellerConfig {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  taxId: string;
  krs?: string | null;
  bankAccount?: string | null;
  departmentId?: string | null;
}

export interface FakturowniaInvoiceLineSnapshot {
  name: string;
  quantity: number;
  quantityUnit?: string;
  unitNetMinor: number;
  unitGrossMinor?: number;
  totalNetMinor?: number;
  totalGrossMinor?: number;
  vatRate: string;
}

export interface FakturowniaInvoiceSnapshot {
  orderRef: string;
  issueDate: string;
  sellDate?: string;
  currency: string;
  seller?: FakturowniaSellerConfig;
  buyer: {
    name: string;
    email: string | null;
    taxId: string | null;
    companyName?: string | null;
    address?: {
      line1: string | null;
      postalCode: string | null;
      city: string | null;
      country: string | null;
    };
  };
  documentKind?: "b2b_vat" | "b2c_named";
  ksefRequired?: boolean;
  payment?: {
    provider: string | null;
    providerPaymentId: string | null;
    paymentCompletedAt: string;
  };
  lines: FakturowniaInvoiceLineSnapshot[];
  chargedTotalGrossMinor?: number;
}

export interface FakturowniaCorrectionSnapshot {
  providerInvoiceId: string;
  orderRef: string;
  reason: string;
  documentKind: "b2b_vat" | "b2c_named";
  ksefRequired: boolean;
  buyer: FakturowniaInvoiceSnapshot["buyer"];
  lines: Array<{
    name: string;
    quantityBefore: number;
    quantityAfter: number;
    quantityUnit?: string;
    totalGrossBeforeMinor: number;
    totalGrossAfterMinor: number;
    vatRate: string;
  }>;
}

export interface FakturowniaStatusSnapshot {
  providerEventId: string;
  providerInvoiceId: string;
  providerInvoiceNumber: string | null;
  ksefNumber: string | null;
  ksefStatus: string | null;
  pdfRef?: string | null;
  xmlRef?: string | null;
  upoRef?: string | null;
  observedAt: string;
}

export function buildFakturowniaInvoiceDraft(
  snapshot: FakturowniaInvoiceSnapshot,
) {
  assertPositionsMatchChargedTotal(snapshot);
  const documentKind = snapshot.documentKind ?? (snapshot.buyer.taxId ? "b2b_vat" : "b2c_named");
  const seller = "seller" in snapshot ? snapshot.seller : undefined;
  const payment = "payment" in snapshot ? snapshot.payment : undefined;
  const sellDate = "sellDate" in snapshot ? snapshot.sellDate : snapshot.issueDate;

  return {
    kind: "vat",
    issue_date: snapshot.issueDate,
    sell_date: sellDate,
    currency: snapshot.currency,
    seller_name: seller?.name,
    seller_tax_no: seller?.taxId,
    seller_post_code: seller?.postalCode,
    seller_city: seller?.city,
    seller_street: seller?.street,
    seller_country: "PL",
    seller_bank_account: seller?.bankAccount ?? undefined,
    department_id: seller?.departmentId ?? undefined,
    ...buildBuyerFields(snapshot.buyer, documentKind),
    ...settlementFields(
      centsToDecimal(snapshot.lines.reduce((sum, line) => sum + lineTotalGrossMinor(line), 0)),
      payment?.paymentCompletedAt?.slice(0, 10) || sellDate || snapshot.issueDate,
    ),
    descriptions: documentNotes(snapshot.orderRef),
    internal_note: paymentEvidenceNote(snapshot.orderRef, payment),
    positions: snapshot.lines.map((line) => ({
      name: truncateKsefText(line.name, 240),
      quantity: line.quantity,
      quantity_unit: quantityUnit(line),
      total_price_net: centsToDecimal(lineTotalNetMinor(line)),
      total_price_gross: centsToDecimal(lineTotalGrossMinor(line)),
      tax: line.vatRate,
    })),
    external_id: snapshot.orderRef,
    oid: snapshot.orderRef,
    oid_unique: "yes",
  };
}

export function buildFakturowniaCreateInvoiceRequest(
  snapshot: FakturowniaInvoiceSnapshot,
) {
  const documentKind = snapshot.documentKind ?? (snapshot.buyer.taxId ? "b2b_vat" : "b2c_named");
  if (documentKind === "b2b_vat") buildBuyerFields(snapshot.buyer, documentKind);
  const draft = stripUndefined(buildFakturowniaInvoiceDraft(snapshot));
  return {
    invoice: draft,
  };
}

export function buildFakturowniaCorrectionRequest(
  snapshot: FakturowniaCorrectionSnapshot,
) {
  return {
    invoice: stripUndefined({
      kind: "correction",
      correction_reason: snapshot.reason,
      invoice_id: snapshot.providerInvoiceId,
      from_invoice_id: snapshot.providerInvoiceId,
      ...buildBuyerFields(snapshot.buyer, snapshot.documentKind),
      descriptions: documentNotes(snapshot.orderRef),
      positions: snapshot.lines.map((line) => ({
        name: line.name,
        quantity: line.quantityAfter - line.quantityBefore,
        quantity_unit: quantityUnit(line),
        total_price_gross: centsToDecimal(line.totalGrossAfterMinor - line.totalGrossBeforeMinor),
        tax: line.vatRate,
        kind: "correction",
        correction_before_attributes: {
          name: line.name,
          quantity: line.quantityBefore,
          quantity_unit: quantityUnit(line),
          total_price_gross: centsToDecimal(line.totalGrossBeforeMinor),
          tax: line.vatRate,
          kind: "correction_before",
        },
        correction_after_attributes: {
          name: line.name,
          quantity: line.quantityAfter,
          quantity_unit: quantityUnit(line),
          total_price_gross: centsToDecimal(line.totalGrossAfterMinor),
          tax: line.vatRate,
          kind: "correction_after",
        },
      })),
    }),
  };
}

export function mapFakturowniaProviderSync(snapshot: FakturowniaStatusSnapshot) {
  const normalized = normalizeKsefStatus(snapshot.ksefStatus);
  return {
    providerKind: "fakturownia",
    providerEventId: snapshot.providerEventId,
    providerInvoiceId: snapshot.providerInvoiceId,
    providerInvoiceNumber: snapshot.providerInvoiceNumber,
    ksefNumber: snapshot.ksefNumber,
    ksefStatus: normalized.ksefStatus,
    eventType: normalized.eventType,
    statusSource: "provider_api",
    providerPdfRef: snapshot.pdfRef ?? null,
    providerXmlRef: snapshot.xmlRef ?? null,
    providerUpoRef: snapshot.upoRef ?? null,
    observedAt: snapshot.observedAt,
  };
}

function normalizeKsefStatus(status: string | null): {
  ksefStatus: "not_submitted" | "pending" | "accepted" | "rejected" | "not_required" | null;
  eventType:
    | "invoice.created"
    | "ksef.pending"
    | "ksef.accepted"
    | "ksef.rejected"
    | "provider.mismatch";
} {
  const value = status?.trim().toLowerCase() ?? "";
  if (["accepted", "accepted_by_ksef", "wyslana", "przyjeta", "ok", "demo_ok"].includes(value)) {
    return { ksefStatus: "accepted", eventType: "ksef.accepted" };
  }
  if (["pending", "processing", "sent", "w_trakcie", "oczekuje", "demo_processing"].includes(value)) {
    return { ksefStatus: "pending", eventType: "ksef.pending" };
  }
  if (["rejected", "error", "failed", "odrzucona", "send_error", "server_error", "demo_send_error", "demo_server_error"].includes(value)) {
    return { ksefStatus: "rejected", eventType: "ksef.rejected" };
  }
  if (["not_required", "not_applicable", "not_connected", "demo_not_applicable", "demo_not_connected"].includes(value)) {
    return { ksefStatus: "not_required", eventType: "invoice.created" };
  }
  if (!value) return { ksefStatus: null, eventType: "invoice.created" };
  return { ksefStatus: null, eventType: "provider.mismatch" };
}

// Payment evidence identifies the settlement, not the sale. It rides the private
// note, off the document and the submission; with nothing to evidence, it drops.
function paymentEvidenceNote(
  orderRef: string,
  payment: FakturowniaInvoiceSnapshot["payment"] | undefined,
): string | undefined {
  const parts: string[] = [];
  if (payment?.provider) parts.push(`payment provider: ${payment.provider}`);
  if (payment?.providerPaymentId) parts.push(`payment id: ${payment.providerPaymentId}`);
  if (payment?.paymentCompletedAt) parts.push(`paid at: ${payment.paymentCompletedAt}`);
  return parts.length ? [`openlup order: ${orderRef}`, ...parts].join(" | ") : undefined;
}

function lineTotalGrossMinor(line: FakturowniaInvoiceLineSnapshot): number {
  return line.totalGrossMinor ?? (line.unitGrossMinor ?? line.unitNetMinor) * line.quantity;
}

function lineTotalNetMinor(line: FakturowniaInvoiceLineSnapshot): number {
  return line.totalNetMinor ?? line.unitNetMinor * line.quantity;
}

// Fakturownia recomputes the document total from positions, so a document whose
// positions disagree with the charged amount must never be built. Fail closed.
function assertPositionsMatchChargedTotal(snapshot: FakturowniaInvoiceSnapshot): void {
  const chargedTotal = snapshot.chargedTotalGrossMinor;
  if (chargedTotal === undefined) return;
  const positionsTotal = snapshot.lines.reduce((sum, line) => sum + lineTotalGrossMinor(line), 0);
  if (positionsTotal !== Math.round(chargedTotal)) {
    throw new Error(
      `fakturownia_invoice_positions_total_mismatch positions=${positionsTotal} charged=${chargedTotal}`,
    );
  }
}

function centsToDecimal(value: number): number {
  return Math.round(value) / 100;
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, stripUndefined(entry)]),
  ) as T;
}

function truncateKsefText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

// Fakturownia requires buyer data on every document — a correction without it is
// rejected 422 buyer_name "nie może być puste" (live, 2026-07-13). Invalid NIP throws.
function buildBuyerFields(buyer: FakturowniaInvoiceSnapshot["buyer"], documentKind: "b2b_vat" | "b2c_named") {
  const buyerTaxId = documentKind === "b2b_vat" ? normalizePolishNip(buyer.taxId) : null;
  if (documentKind === "b2b_vat" && (!buyerTaxId || !isValidPolishNip(buyerTaxId))) {
    throw new Error("fakturownia_b2b_invoice_invalid_tax_id");
  }
  return {
    buyer_company: documentKind === "b2b_vat",
    buyer_name: truncateKsefText(buyer.name, 240),
    buyer_email: buyer.email,
    buyer_tax_no: buyerTaxId,
    buyer_tax_no_kind: documentKind === "b2b_vat" ? "" : undefined,
    buyer_post_code: buyer.address?.postalCode ?? undefined,
    buyer_city: buyer.address?.city ?? undefined,
    buyer_street: buyer.address?.line1 ?? undefined,
    buyer_country: buyer.address?.country ?? "PL",
  };
}
