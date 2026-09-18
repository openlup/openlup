import {
  evaluatePreviewFulfillmentHandoffProof,
  type PreviewFulfillmentHandoffProofInput,
} from "../fulfillment/previewHandoffProof.js";
import {
  evaluateStripeAccountingPreviewPaymentProof,
  type StripeAccountingPreviewPaymentCase,
  type StripePreviewPaymentProofInput,
} from "../payment/stripePreviewPaymentProof.js";

export const STRIPE_ACCOUNTING_E2E_PROOF_VERSION = "stripe_accounting_preview_e2e.v1";

export type StripeAccountingE2EProofInput = {
  version: typeof STRIPE_ACCOUNTING_E2E_PROOF_VERSION;
  providerScope: readonly ["stripe"];
  capturedAt: string;
  previewHost: string;
  stagingSupabaseRef: string;
  linkedPaymentCaseId: StripeAccountingPreviewPaymentCase;
  payment: StripePreviewPaymentProofInput;
  fulfillment: PreviewFulfillmentHandoffProofInput;
  accounting: {
    orderId: string;
    fulfillmentOrderId: string;
    invoiceId: string;
    status: "issue_requested" | "issued" | "accepted" | "blocked" | "failed";
    providerKind: "fakturownia_test" | string;
    providerInvoiceId?: string | null;
    providerInvoiceNumber?: string | null;
    governmentClearanceRequired: boolean;
    ksefStatus: "not_required" | string;
    emailStatus: "sent" | string;
    shadowInvoiceRequestCreatedBeforeJob: boolean;
    accountingJobRan: boolean;
  };
  customerDocument: {
    orderId: string;
    invoiceId: string;
    accountSummaryDownloadAvailable: boolean;
    accountSummaryDownloadUrl: string | null;
    ownerDownloadHttpStatus: number;
    pdfContentType: string;
    pdfCacheControl: string | null;
    pdfByteLength: number;
    nonFiscalTestMarkerPresent: boolean;
  };
  negativeProofs: {
    invalidNip: {
      orderId: string;
      invoiceId: string;
      status: "blocked" | string;
      blockedReason: "invalid_tax_id" | string | null;
      providerInvoiceId?: string | null;
    };
    missingBearer: {
      httpStatus: number;
      providerFetchAttempted: boolean;
    };
    wrongCustomer: {
      httpStatus: number;
      providerFetchAttempted: boolean;
    };
  };
  notes?: string | null;
};

export type StripeAccountingE2EProofDecision = {
  readyForStripeAccountingPreviewE2E: boolean;
  reasons: string[];
  paymentReady: boolean;
  fulfillmentReady: boolean;
  evidenceSummary: {
    previewHost: string;
    stagingSupabaseRef: string;
    linkedPaymentCaseId: StripeAccountingPreviewPaymentCase;
    orderId: string;
    fulfillmentOrderId: string;
    invoiceId: string;
    providerKind: string;
    pdfNegativeChecks: readonly ["missing_bearer", "wrong_customer", "invalid_nip"];
  };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HTTPS_PREVIEW_RE = /^https:\/\/[A-Za-z0-9.-]+$/;
const INTERNAL_INVOICE_DOWNLOAD_RE =
  /^\/api\/bff\/customers\/invoices\/download\?invoiceId=[0-9a-f-]{36}$/i;
const SECRET_SHAPE_RE =
  /(sk_(?:test|live)_[A-Za-z0-9_]+|rk_(?:test|live)_[A-Za-z0-9_]+|whsec_[A-Za-z0-9_]+|pi_[A-Za-z0-9_]+_secret_[A-Za-z0-9_]+|\b(?:api[_-]?key|apiKey|auth[_-]?token|authToken|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|secret[_-]?key|secretKey)\b|client_secret|clientSecret|authorization:\s*bearer|bearer\s+[A-Za-z0-9._-]+|token\s*[:=])/i;

export function evaluateStripeAccountingPreviewE2EProof(
  input: StripeAccountingE2EProofInput,
): StripeAccountingE2EProofDecision {
  const reasons: string[] = [];
  if (input.version !== STRIPE_ACCOUNTING_E2E_PROOF_VERSION) {
    reasons.push(`version must be ${STRIPE_ACCOUNTING_E2E_PROOF_VERSION}`);
  }
  if (input.providerScope.length !== 1 || input.providerScope[0] !== "stripe") {
    reasons.push("providerScope must be exactly [\"stripe\"]");
  }
  if (Number.isNaN(Date.parse(input.capturedAt))) {
    reasons.push("capturedAt must be an ISO-compatible timestamp");
  }
  if (!HTTPS_PREVIEW_RE.test(input.previewHost)) {
    reasons.push("previewHost must be an https preview host");
  }
  if (!input.stagingSupabaseRef.trim()) {
    reasons.push("stagingSupabaseRef is required");
  }
  if (containsSecretShape(input)) {
    reasons.push("proof payload contains secret-shaped data");
  }

  const paymentDecision = evaluateStripeAccountingPreviewPaymentProof(input.payment);
  const fulfillmentDecision = evaluatePreviewFulfillmentHandoffProof(input.fulfillment);
  if (!paymentDecision.readyForAccountingPreviewPaymentProof) {
    reasons.push(...paymentDecision.reasons.map((reason) => `payment: ${reason}`));
  }
  if (!fulfillmentDecision.readyForAccountingPreviewFulfillmentProof) {
    reasons.push(...fulfillmentDecision.reasons.map((reason) => `fulfillment: ${reason}`));
  }

  validateCrossProofConsistency(input, reasons);
  validateAccountingProof(input, reasons);
  validateCustomerDocumentProof(input, reasons);
  validateNegativeProofs(input, reasons);

  return {
    readyForStripeAccountingPreviewE2E: reasons.length === 0,
    reasons,
    paymentReady: paymentDecision.readyForAccountingPreviewPaymentProof,
    fulfillmentReady: fulfillmentDecision.readyForAccountingPreviewFulfillmentProof,
    evidenceSummary: {
      previewHost: input.previewHost,
      stagingSupabaseRef: input.stagingSupabaseRef,
      linkedPaymentCaseId: input.linkedPaymentCaseId,
      orderId: input.accounting.orderId,
      fulfillmentOrderId: input.accounting.fulfillmentOrderId,
      invoiceId: input.accounting.invoiceId,
      providerKind: input.accounting.providerKind,
      pdfNegativeChecks: ["missing_bearer", "wrong_customer", "invalid_nip"],
    },
  };
}

function validateCrossProofConsistency(input: StripeAccountingE2EProofInput, reasons: string[]): void {
  if (input.payment.previewHost !== input.previewHost) {
    reasons.push("payment previewHost must match top-level previewHost");
  }
  if (input.fulfillment.previewHost !== input.previewHost) {
    reasons.push("fulfillment previewHost must match top-level previewHost");
  }
  const linkedCase = input.payment.cases.find((entry) => entry.caseId === input.linkedPaymentCaseId);
  if (!linkedCase) {
    reasons.push("linkedPaymentCaseId must identify a payment proof case");
    return;
  }
  if (linkedCase.status !== "passed") {
    reasons.push("linked payment proof case must be passed");
  }
  if (linkedCase.local.orderId !== input.fulfillment.order.orderId) {
    reasons.push("fulfillment order must be the order from the linked Stripe payment proof");
  }
  if (linkedCase.local.providerPaymentId !== input.fulfillment.order.providerPaymentId) {
    reasons.push("fulfillment provider payment id must match the linked Stripe payment proof");
  }
  if (input.accounting.orderId !== input.fulfillment.order.orderId) {
    reasons.push("accounting orderId must match fulfilled order");
  }
  if (input.accounting.fulfillmentOrderId !== input.fulfillment.fulfillment.fulfillmentOrderId) {
    reasons.push("accounting fulfillmentOrderId must match handoff proof");
  }
  if (input.customerDocument.orderId !== input.accounting.orderId) {
    reasons.push("customer document orderId must match accounting orderId");
  }
  if (input.customerDocument.invoiceId !== input.accounting.invoiceId) {
    reasons.push("customer document invoiceId must match accounting invoiceId");
  }
}

function validateAccountingProof(input: StripeAccountingE2EProofInput, reasons: string[]): void {
  const invoice = input.accounting;
  if (!UUID_RE.test(invoice.orderId)) reasons.push("accounting orderId must be a UUID");
  if (!UUID_RE.test(invoice.fulfillmentOrderId)) reasons.push("accounting fulfillmentOrderId must be a UUID");
  if (!UUID_RE.test(invoice.invoiceId)) reasons.push("accounting invoiceId must be a UUID");
  if (!["issued", "accepted"].includes(invoice.status)) {
    reasons.push("accounting invoice status must be issued or accepted");
  }
  if (invoice.providerKind !== "fakturownia_test") {
    reasons.push("accounting providerKind must be fakturownia_test");
  }
  if (!invoice.providerInvoiceId?.trim()) {
    reasons.push("accounting providerInvoiceId is required for issued test invoice");
  }
  if (invoice.governmentClearanceRequired !== false || invoice.ksefStatus !== "not_required") {
    reasons.push("B2C accounting proof must show KSeF not_required");
  }
  if (invoice.emailStatus !== "sent") {
    reasons.push("B2C accounting proof must show emailStatus=sent");
  }
  if (invoice.shadowInvoiceRequestCreatedBeforeJob !== true) {
    reasons.push("shadow invoice request must be created before the accounting job");
  }
  if (invoice.accountingJobRan !== true) {
    reasons.push("accounting job execution proof is required");
  }
}

function validateCustomerDocumentProof(input: StripeAccountingE2EProofInput, reasons: string[]): void {
  const proof = input.customerDocument;
  if (proof.accountSummaryDownloadAvailable !== true) {
    reasons.push("customer account summary must expose downloadAvailable=true");
  }
  if (!proof.accountSummaryDownloadUrl || !INTERNAL_INVOICE_DOWNLOAD_RE.test(proof.accountSummaryDownloadUrl)) {
    reasons.push("customer account summary must expose the internal invoice PDF download URL");
  }
  if (proof.ownerDownloadHttpStatus !== 200) {
    reasons.push("owner invoice PDF download must return HTTP 200");
  }
  if (!proof.pdfContentType.toLowerCase().includes("application/pdf")) {
    reasons.push("owner invoice PDF must return application/pdf");
  }
  if (proof.pdfCacheControl !== "no-store") {
    reasons.push("owner invoice PDF must return Cache-Control: no-store");
  }
  if (proof.pdfByteLength < 20) {
    reasons.push("owner invoice PDF byte-length proof is too small");
  }
  if (proof.nonFiscalTestMarkerPresent !== true) {
    reasons.push("owner invoice PDF must contain the non-fiscal test marker");
  }
}

function validateNegativeProofs(input: StripeAccountingE2EProofInput, reasons: string[]): void {
  const invalidNip = input.negativeProofs.invalidNip;
  if (!UUID_RE.test(invalidNip.orderId)) reasons.push("invalid-NIP orderId must be a UUID");
  if (!UUID_RE.test(invalidNip.invoiceId)) reasons.push("invalid-NIP invoiceId must be a UUID");
  if (invalidNip.status !== "blocked") reasons.push("invalid-NIP invoice must be blocked");
  if (invalidNip.blockedReason !== "invalid_tax_id") {
    reasons.push("invalid-NIP invoice must have blockedReason=invalid_tax_id");
  }
  if (invalidNip.providerInvoiceId?.trim()) {
    reasons.push("invalid-NIP invoice must not receive a providerInvoiceId");
  }

  if (input.negativeProofs.missingBearer.httpStatus !== 401) {
    reasons.push("missing bearer invoice PDF request must return HTTP 401");
  }
  if (input.negativeProofs.missingBearer.providerFetchAttempted !== false) {
    reasons.push("missing bearer invoice PDF request must not fetch provider PDF");
  }
  if (input.negativeProofs.wrongCustomer.httpStatus !== 404) {
    reasons.push("wrong-customer invoice PDF request must return HTTP 404");
  }
  if (input.negativeProofs.wrongCustomer.providerFetchAttempted !== false) {
    reasons.push("wrong-customer invoice PDF request must not fetch provider PDF");
  }
}

function containsSecretShape(value: unknown): boolean {
  if (typeof value === "string") return SECRET_SHAPE_RE.test(value);
  if (Array.isArray(value)) return value.some(containsSecretShape);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
    SECRET_SHAPE_RE.test(key) || containsSecretShape(nested),
  );
}
