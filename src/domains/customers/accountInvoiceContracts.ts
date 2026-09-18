import { platformCurrencySchema } from "../../lib/currency/platformCurrency.js";
import { z } from "../../lib/validation/zod.js";

const uuidSchema = z.guid();
const datetimeSchema = z.string().datetime({ offset: true });
const moneySchema = z.object({
  amountMinor: z.number().int().nonnegative(),
  currency: platformCurrencySchema,
});

const customerInvoiceDownloadUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => {
    if (value.startsWith("/api/bff/customers/invoices/download?invoiceId=")) return true;
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }, "Invalid invoice download URL");

export const customerDocumentDeliveryStatusSchema = z.enum([
  "not_ready",
  "pdf_ready",
  "ksef_pending",
  "email_pending",
  "email_provider_accepted",
  "email_sent",
  "requires_correction",
  "delivery_failed",
]);
export const customerInvoiceRequestStatusSchema = z.enum([
  "not_requested",
  "preparing",
  "available",
]);
export const customerInvoiceDocumentRoleSchema = z.enum([
  "original",
  "correction",
  "replacement",
]);
export const customerInvoiceDownloadArtifactSchema = z.enum([
  "invoice",
  "correction",
]);

export const customerInvoiceSummarySchema = z
  .object({
    invoiceId: uuidSchema,
    orderId: uuidSchema,
    invoiceRef: z.string().min(1).max(160),
    status: z.string().min(1).max(80),
    providerInvoiceNumber: z.string().max(160).nullable(),
    ksefNumber: z.string().max(160).nullable(),
    ksefStatus: z.string().min(1).max(80),
    documentDeliveryStatus: customerDocumentDeliveryStatusSchema,
    totalGross: moneySchema,
    issuedAt: datetimeSchema.nullable(),
    downloadAvailable: z.boolean(),
    downloadUrl: customerInvoiceDownloadUrlSchema.nullable(),
    createdAt: datetimeSchema,
  })
  .strict();

export const customerInvoiceDocumentSchema = customerInvoiceSummarySchema
  .omit({ totalGross: true })
  .extend({
    documentKey: z.string().trim().min(1).max(160),
    role: customerInvoiceDocumentRoleSchema,
    artifact: customerInvoiceDownloadArtifactSchema,
    isCurrent: z.boolean(),
    totalGross: moneySchema.nullable(),
  })
  .strict();

export const customerInvoiceDownloadRequestSchema = z
  .object({
    invoiceId: uuidSchema,
    artifact: customerInvoiceDownloadArtifactSchema.default("invoice"),
  })
  .strict();

export type CustomerDocumentDeliveryStatus = z.infer<typeof customerDocumentDeliveryStatusSchema>;
export type CustomerInvoiceDocumentRole = z.infer<typeof customerInvoiceDocumentRoleSchema>;
export type CustomerInvoiceDownloadArtifact = z.infer<typeof customerInvoiceDownloadArtifactSchema>;
export type CustomerInvoiceDownloadRequest = z.infer<typeof customerInvoiceDownloadRequestSchema>;
