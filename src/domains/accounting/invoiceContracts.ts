import type { AccountingDocumentKind } from "./accountingConstants.js";
import { normalizePolishNip } from "../../lib/schemas/fields/taxId.js";
import type { InvoiceRoutingDecision } from "../../lib/schemas/fields/taxId.js";

export {
  ACCOUNTING_ACTIVATION_GATE_CASES,
  ACCOUNTING_BUYER_KINDS,
  ACCOUNTING_DOCUMENT_KINDS,
  ACCOUNTING_DOCUMENT_TYPES,
  ACCOUNTING_EMAIL_STATUSES,
  ACCOUNTING_INVOICE_STATUSES,
  ACCOUNTING_PROVIDER_SYNC_EVENT_TYPES,
  INVOICE_DATA_LOOKUP_STATUSES,
  INVOICE_DATA_LOOKUP_VAT_STATUSES,
  KSEF_REQUIREMENTS,
  KSEF_STATUSES,
  PAYMENT_SETTLEMENT_ITEM_STATUSES,
} from "./accountingConstants.js";
export type {
  AccountingActivationGateCase,
  AccountingBuyerKind,
  AccountingDocumentKind,
  AccountingDocumentType,
  AccountingEmailStatus,
  AccountingInvoiceStatus,
  AccountingProviderSyncEventType,
  InvoiceDataLookupStatus,
  InvoiceDataLookupVatStatus,
  KsefRequirement,
  KsefStatus,
  PaymentSettlementItemStatus,
} from "./accountingConstants.js";

export interface LocalInvoiceLineSnapshot {
  name: string;
  quantity: number;
  unitNetMinor: number;
  unitGrossMinor?: number;
  vatRate: string;
  totalNetMinor: number;
  totalGrossMinor: number;
}

export interface AccountingSellerConfig {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  taxId: string;
  krs: string;
  bankAccount: string | null;
  departmentId: string | null;
}

export interface AccountingBuyerSnapshot {
  name: string;
  email: string | null;
  taxId: string | null;
  companyName: string | null;
}

export interface AccountingPaymentEvidence {
  provider: string | null;
  providerPaymentId: string | null;
  paymentCompletedAt: string;
}

export interface LocalInvoiceSnapshot {
  orderId: string;
  orderRef: string;
  invoiceRef?: string;
  documentKind: AccountingDocumentKind;
  issueDate: string;
  sellDate: string;
  currency: string;
  seller?: AccountingSellerConfig;
  buyer: AccountingBuyerSnapshot;
  payment: AccountingPaymentEvidence;
  packageShippedAt: string;
  taxSnapshot: Record<string, unknown>;
  lines: LocalInvoiceLineSnapshot[];
  governmentClearanceRequired: boolean;
}

export function calculateGrossMinor(netMinor: number, vatRatePercent: number): number {
  return Math.round(netMinor * (1 + vatRatePercent / 100));
}

export {
  accountingInvoiceIssueRequestSchema,
  accountingInvoiceIssueResponseSchema,
  accountingInvoiceSummarySchema,
  adminAccountingOutboxLastErrorSchema,
  adminAccountingOrderSummaryRequestSchema,
  adminAccountingOrderSummaryResponseSchema,
  adminAccountingOrderSummarySchema,
  adminAccountingRecoveryGuidanceSchema,
  accountingProviderSyncEventSchema,
  accountingProviderSyncResponseSchema,
  invoiceDataLookupRequestSchema,
  invoiceDataLookupResponseSchema,
  invoiceDocumentPolicySchema,
  paymentProviderSettlementRecordSchema,
  paymentProviderSettlementResponseSchema,
} from "./accountingControlContracts.js";
export type {
  AccountingInvoiceIssueRequest,
  AccountingInvoiceIssueResponse,
  AdminAccountingOrderSummary,
  AdminAccountingOrderSummaryRequest,
  AdminAccountingOrderSummaryResponse,
  AccountingProviderSyncEvent,
  AccountingProviderSyncResponse,
  InvoiceDataLookupRequest,
  InvoiceDataLookupResponse,
  InvoiceDocumentPolicy,
  PaymentProviderSettlementRecord,
  PaymentProviderSettlementResponse,
} from "./accountingControlContracts.js";
export {
  formatPolishNip,
  isValidPolishNip,
  normalizeOptionalPolishNipForStorage,
  normalizePolishNip,
  routeInvoiceByTaxId,
} from "../../lib/schemas/fields/taxId.js";
export type { InvoiceRoutingDecision } from "../../lib/schemas/fields/taxId.js";

/**
 * How a deployment turns a buyer's tax id into a document decision.
 *
 * A port rather than a direct call, because the rule is entirely
 * jurisdictional: which registries exist, what a valid identifier looks like,
 * whether holding one makes the sale a business sale, and whether the resulting
 * document has to be cleared by a tax authority are four different national
 * answers. `routeInvoiceByTaxId` above is one such module — this deployment's —
 * and it is opted into by composition, not by being the default.
 */
export type TaxIdRoutingPort = (taxId: string | null | undefined) => InvoiceRoutingDecision;

/**
 * The default: absence is answered, presence is refused.
 *
 * "No tax id was supplied, so this is a consumer document" is true in every
 * jurisdiction and needs no local knowledge. "Here is a tax id" does: a platform
 * that has not been told how to read one cannot tell a real registration from a
 * typed-in string, and the failure mode of guessing is a business document with
 * an unverified tax id sent to a fiscal provider. So this refuses, by a name
 * that says the configuration is missing rather than that the id is bad — the
 * operator's fix is to compose a routing module, not to correct the buyer.
 */
export const neutralTaxIdRouting: TaxIdRoutingPort = (taxId) => {
  const trimmed = typeof taxId === "string" ? taxId.trim() : "";
  return trimmed === ""
    ? { ok: true, documentKind: "b2c_named", normalizedTaxId: null, governmentClearanceRequired: false }
    : { ok: false, reason: "tax_id_routing_not_configured", normalizedTaxId: trimmed };
};

// Generic seller-config reader: overlays ACCOUNTING_SELLER_* env onto the
// brand-supplied `fallback` (the app-level defaults live outside accounting).
// Core holds no brand identity.
export function readAccountingSellerConfig(
  env: Record<string, string | undefined>,
  fallback: AccountingSellerConfig,
): AccountingSellerConfig {
  return {
    name: readEnv(env, "ACCOUNTING_SELLER_NAME", fallback.name),
    street: readEnv(env, "ACCOUNTING_SELLER_STREET", fallback.street),
    postalCode: readEnv(env, "ACCOUNTING_SELLER_POSTAL_CODE", fallback.postalCode),
    city: readEnv(env, "ACCOUNTING_SELLER_CITY", fallback.city),
    taxId: normalizePolishNip(readEnv(env, "ACCOUNTING_SELLER_NIP", fallback.taxId)) ?? fallback.taxId,
    krs: readEnv(env, "ACCOUNTING_SELLER_KRS", fallback.krs),
    bankAccount: readOptionalEnv(env, "ACCOUNTING_SELLER_BANK_ACCOUNT") ?? fallback.bankAccount,
    departmentId: readOptionalEnv(env, "FAKTUROWNIA_DEPARTMENT_ID"),
  };
}

function readEnv(env: Record<string, string | undefined>, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value || fallback;
}

function readOptionalEnv(env: Record<string, string | undefined>, name: string): string | null {
  const value = env[name]?.trim();
  return value || null;
}
