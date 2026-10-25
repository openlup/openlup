export type { OmsPaymentMethodSummary } from "@openlup/platform/commerce/contracts";
import { paymentMethodForOrder as summarize } from "@openlup/platform/commerce";
import type { OmsPaymentAttemptRow,OmsPaymentIntentRow } from "./omsReadModelRows.js";
import { referenceOmsProjections } from "./omsReferenceBinding.js";
export function paymentMethodForOrder(orderId: string, intents: OmsPaymentIntentRow[], attempts: OmsPaymentAttemptRow[]) { return summarize(orderId, intents, attempts, referenceOmsProjections); }

export function referencePaymentMethodLabel(attempt: OmsPaymentAttemptRow): string {
 const provider = attempt.provider.toLowerCase();
 if (provider.includes("stripe")) return "Karta";
 if (provider.includes("tpay")) return "BLIK";
 if (provider.includes("blik")) return "BLIK";
 if (provider.includes("card")) return "Karta";
 return attempt.provider;
}
