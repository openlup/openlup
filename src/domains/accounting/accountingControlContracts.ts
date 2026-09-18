import { z } from "../../lib/validation/zod.js";
import {
  ACCOUNTING_BUYER_KINDS,
  ACCOUNTING_DOCUMENT_TYPES,
  ACCOUNTING_INVOICE_STATUSES,
  ACCOUNTING_PROVIDER_SYNC_EVENT_TYPES,
  INVOICE_DATA_LOOKUP_STATUSES,
  INVOICE_DATA_LOOKUP_VAT_STATUSES,
  KSEF_REQUIREMENTS,
  KSEF_STATUSES,
  PAYMENT_SETTLEMENT_ITEM_STATUSES,
} from "./accountingConstants.js";
import {
  isValidPolishNip,
  normalizePolishNip,
} from "../../lib/schemas/fields/taxId.js";

const uuidSchema = z.guid();
const datetimeSchema = z.string().datetime({ offset: true });
const moneyMinorSchema = z.number().int().nonnegative();
const polishNipLookupSchema = z
  .string()
  .trim()
  .min(6)
  .max(34)
  .regex(/^(?:PL[\s-]*)?[\d\s-]+$/i, "tax ID may contain an optional PL prefix, digits, spaces, and hyphens")
  .transform((value) => normalizePolishNip(value) ?? "")
  .refine(isValidPolishNip, "invalid Polish NIP");

export const invoiceDocumentPolicySchema = z
  .object({
    documentType: z.enum(ACCOUNTING_DOCUMENT_TYPES),
    buyerKind: z.enum(ACCOUNTING_BUYER_KINDS),
    ksefRequirement: z.enum(KSEF_REQUIREMENTS),
    policyVersion: z.string().trim().min(1).max(80),
    approvedBy: uuidSchema,
    approvedAt: datetimeSchema,
    rationale: z.string().trim().min(1).max(500),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.buyerKind === "business" && policy.documentType === "fiscal_receipt") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["documentType"],
        message: "business buyers require an invoice document policy",
      });
    }
    if (policy.buyerKind === "consumer" && policy.ksefRequirement === "required") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ksefRequirement"],
        message: "consumer KSeF cannot be hard-required by default",
      });
    }
  });

export const accountingInvoiceIssueRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(160),
    orderId: uuidSchema,
    invoiceRef: z.string().trim().min(3).max(120),
    providerKind: z.string().trim().min(1).max(80),
    policyApprovalId: uuidSchema,
    policy: invoiceDocumentPolicySchema,
    buyerSnapshot: z.record(z.string(), z.unknown()),
    orderSnapshot: z.record(z.string(), z.unknown()),
    taxSnapshot: z.record(z.string(), z.unknown()),
    linesSnapshot: z.array(z.record(z.string(), z.unknown())).min(1),
    totalNetMinor: moneyMinorSchema,
    totalGrossMinor: moneyMinorSchema,
  })
  .strict()
  .refine((request) => request.totalGrossMinor >= request.totalNetMinor, {
    path: ["totalGrossMinor"],
    message: "gross total cannot be lower than net total",
  });

export const accountingInvoiceSummarySchema = z
  .object({
    id: uuidSchema,
    orderId: uuidSchema,
    invoiceRef: z.string(),
    status: z.enum(ACCOUNTING_INVOICE_STATUSES),
    documentType: z.enum(ACCOUNTING_DOCUMENT_TYPES),
    buyerKind: z.enum(ACCOUNTING_BUYER_KINDS),
    ksefRequirement: z.enum(KSEF_REQUIREMENTS),
    ksefStatus: z.enum(KSEF_STATUSES),
    providerKind: z.string().nullable(),
    providerInvoiceId: z.string().nullable(),
    providerInvoiceNumber: z.string().nullable(),
    totalGrossMinor: moneyMinorSchema,
    currency: z.string().length(3),
    blockedReason: z.string().nullable().optional(),
  })
  .strict();

export const accountingInvoiceIssueResponseSchema = z
  .object({
    invoice: accountingInvoiceSummarySchema,
    replayed: z.boolean(),
  })
  .strict();

export const accountingProviderSyncEventSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(160),
    invoiceId: uuidSchema,
    providerKind: z.string().trim().min(1).max(80),
    providerEventId: z.string().trim().min(1).max(160),
    eventType: z.enum(ACCOUNTING_PROVIDER_SYNC_EVENT_TYPES),
    providerInvoiceId: z.string().trim().min(1).max(160).nullable().default(null),
    providerInvoiceNumber: z.string().trim().min(1).max(160).nullable().default(null),
    ksefNumber: z.string().trim().min(1).max(160).nullable().default(null),
    ksefStatus: z.enum(KSEF_STATUSES).nullable().default(null),
    statusSource: z.enum(["provider_api", "provider_webhook", "manual_reconciliation"]),
    providerPdfRef: z.string().trim().min(1).max(240).nullable().default(null),
    providerXmlRef: z.string().trim().min(1).max(240).nullable().default(null),
    providerUpoRef: z.string().trim().min(1).max(240).nullable().default(null),
    observedAt: datetimeSchema,
    payloadHash: z.string().trim().min(8).max(160),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const accountingProviderSyncResponseSchema = z
  .object({
    eventId: uuidSchema,
    replayed: z.boolean(),
  })
  .strict();

export const paymentProviderSettlementRecordSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(160),
    providerKind: z.string().trim().min(1).max(80),
    providerBatchId: z.string().trim().min(1).max(160),
    providerPaymentId: z.string().trim().min(1).max(160),
    paymentIntentId: uuidSchema.nullable().default(null),
    paymentId: uuidSchema.nullable().default(null),
    invoiceId: uuidSchema.nullable().default(null),
    grossMinor: moneyMinorSchema,
    feeMinor: moneyMinorSchema,
    netMinor: moneyMinorSchema,
    currency: z.string().length(3),
    status: z.enum(PAYMENT_SETTLEMENT_ITEM_STATUSES),
    bankReceivedAt: datetimeSchema.nullable().default(null),
    evidence: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .refine((record) => record.grossMinor >= record.feeMinor, {
    path: ["feeMinor"],
    message: "fee cannot exceed gross amount",
  })
  .refine((record) => record.netMinor === record.grossMinor - record.feeMinor, {
    path: ["netMinor"],
    message: "net amount must equal gross minus fee",
  });

export const paymentProviderSettlementResponseSchema = z
  .object({
    settlementItemId: uuidSchema,
    replayed: z.boolean(),
  })
  .strict();

export const invoiceDataLookupRequestSchema = z
  .object({
    taxId: polishNipLookupSchema,
    country: z.literal("PL").default("PL"),
    providerKind: z.string().trim().min(1).max(80).default("gus_ceidg"),
  })
  .strict();

export const invoiceDataLookupResponseSchema = z
  .object({
    status: z.enum(INVOICE_DATA_LOOKUP_STATUSES),
    providerKind: z.string().trim().min(1).max(80),
    taxId: z.string().trim().min(6).max(32),
    source: z.string().trim().min(1).max(80),
    legalName: z.string().trim().min(1).max(240).nullable(),
    regon: z.string().trim().min(7).max(14).nullable(),
    vatStatus: z.enum(INVOICE_DATA_LOOKUP_VAT_STATUSES).nullable(),
    address: z
      .object({
        line1: z.string().trim().min(1).max(240),
        postalCode: z.string().trim().min(1).max(16),
        city: z.string().trim().min(1).max(120),
        country: z.literal("PL"),
      })
      .nullable(),
    evidenceHash: z.string().trim().min(8).max(160).nullable(),
    observedAt: datetimeSchema,
  })
  .strict();

export const adminAccountingOrderSummaryRequestSchema = z
  .object({
    orderId: uuidSchema,
  })
  .strict();

export const adminAccountingRecoveryGuidanceSchema = z.enum([
  "none",
  "not_requested",
  "wait_for_retry",
  "review_and_retry",
]);

export const adminAccountingOutboxLastErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(80).nullable(),
    message: z.string().trim().min(1).max(240).nullable(),
    retryable: z.boolean().nullable(),
  })
  .strict();

export const adminAccountingDocumentSummarySchema = z
  .object({
    documentKey: z.string().trim().min(1).max(160),
    invoiceId: uuidSchema,
    invoiceRef: z.string().trim().min(1).max(160),
    role: z.enum(["original", "correction", "replacement"]),
    artifact: z.enum(["invoice", "correction"]),
    status: z.string().trim().min(1).max(80),
    providerKind: z.string().trim().min(1).max(80).nullable(),
    providerInvoiceNumber: z.string().trim().min(1).max(160).nullable(),
    totalGrossMinor: moneyMinorSchema.nullable(),
    // The currency the document was issued in, from `accounting_invoices.currency`.
    // Required rather than optional, and shaped exactly like the same field on
    // `accountingInvoiceSummarySchema` above, which has always carried it from the same
    // column: a document that cannot say what its total means is refused by this strict
    // schema instead of arriving at the operator's screen as a bare number for whoever
    // renders it to denominate by guess.
    currency: z.string().length(3),
    emailState: z.enum(["not_requested", "pending", "provider_accepted", "failed"]),
    isCurrent: z.boolean(),
    createdAt: datetimeSchema,
  })
  .strict();

export const adminAccountingOrderSummarySchema = z
  .object({
    orderId: uuidSchema,
    status: z.enum([
      "missing",
      ...ACCOUNTING_INVOICE_STATUSES,
      "outbox_failed",
    ]),
    invoice: accountingInvoiceSummarySchema.nullable(),
    documents: z.array(adminAccountingDocumentSummarySchema).default([]),
    recoveryGuidance: adminAccountingRecoveryGuidanceSchema,
    outbox: z
      .object({
        status: z.string().nullable(),
        attemptCount: z.number().int().nonnegative().nullable(),
        nextAttemptAt: datetimeSchema.nullable(),
        lastError: adminAccountingOutboxLastErrorSchema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const adminAccountingOrderSummaryResponseSchema = z
  .object({
    summary: adminAccountingOrderSummarySchema,
  })
  .strict();

export type InvoiceDocumentPolicy = z.infer<typeof invoiceDocumentPolicySchema>;
export type AccountingInvoiceIssueRequest = z.infer<typeof accountingInvoiceIssueRequestSchema>;
export type AccountingInvoiceIssueResponse = z.infer<typeof accountingInvoiceIssueResponseSchema>;
export type AccountingProviderSyncEvent = z.infer<typeof accountingProviderSyncEventSchema>;
export type AccountingProviderSyncResponse = z.infer<typeof accountingProviderSyncResponseSchema>;
export type PaymentProviderSettlementRecord = z.infer<typeof paymentProviderSettlementRecordSchema>;
export type PaymentProviderSettlementResponse = z.infer<typeof paymentProviderSettlementResponseSchema>;
export type InvoiceDataLookupRequest = z.infer<typeof invoiceDataLookupRequestSchema>;
export type InvoiceDataLookupResponse = z.infer<typeof invoiceDataLookupResponseSchema>;
export type AdminAccountingOrderSummary = z.infer<typeof adminAccountingOrderSummarySchema>;
export type AdminAccountingOrderSummaryRequest = z.infer<typeof adminAccountingOrderSummaryRequestSchema>;
export type AdminAccountingOrderSummaryResponse = z.infer<typeof adminAccountingOrderSummaryResponseSchema>;
