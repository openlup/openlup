import { z } from "../../lib/validation/zod.js";

// Contract for the back-in-stock "Powiadom mnie, gdy wróci" (notify-me) BFF.
// A visitor subscribes an email to a sku; the BFF records marketing consent and
// upserts the subscription. The response is intentionally minimal — no PII echo,
// just an acknowledgement so the UI can confirm.

export const STOCK_NOTIFY_CONTRACT_VERSION = "commerce.stock_notify.v1";

export const stockNotifyRequestSchema = z
  .object({
    sku: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(254),
    // The visitor explicitly opts into marketing-class alerts; the BFF refuses
    // to subscribe without it (consent is the lawful basis for the email).
    marketingConsent: z.literal(true),
    locale: z.enum(["pl", "en"]).optional(),
  })
  .strict();

export const stockNotifyResponseSchema = z
  .object({
    contractVersion: z.literal(STOCK_NOTIFY_CONTRACT_VERSION),
    subscribed: z.boolean(),
  })
  .strict();

export type StockNotifyRequest = z.infer<typeof stockNotifyRequestSchema>;
export type StockNotifyResponse = z.infer<typeof stockNotifyResponseSchema>;
