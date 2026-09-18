import { z } from "../../lib/validation/zod.js";
import artifact from "../../../config/canonical-order-money-legacy-exceptions.json" with { type: "json" };
import type {
  OrderMoneyMismatchCode,
  OrderMoneyReconciliationEvidence,
} from "./orderMoneyReconciliationContracts.js";

const mismatchCodeSchema = z.enum([
  "charge_intent_count", "intent_amount", "intent_currency", "succeeded_attempt_count",
  "intent_active_attempt", "intent_attempt_payment_ref", "attempt_amount", "attempt_currency",
  "trusted_provider_event_missing", "provider_event_amount", "provider_event_currency",
  "provider_event_provider", "provider_event_payment_ref", "provider_reconciliation_currency",
  "provider_settlement_payment_ref", "provider_settlement_correlation", "provider_settlement_provider",
  "provider_settlement_status", "provider_settlement_amount", "provider_settlement_currency",
  "base_invoice_count", "order_header", "invoice_amount", "invoice_net_amount", "invoice_currency",
  "invoice_positions_invalid", "invoice_positions_gross", "invoice_positions_net",
  "invoice_positions_order_items", "invoice_positions_catalog", "invoice_positions_discount",
  "invoice_positions_shipping", "invoice_positions_shipping_discount", "subscription_cycle_missing",
]);

const legacyExceptionSchema = z.object({
  orderId: z.guid(),
  rootInvoiceId: z.guid(),
  replacementInvoiceId: z.guid(),
  grossCents: z.number().int().nonnegative(),
  currency: z.string().length(3).transform((value) => value.toUpperCase()),
  mismatchCodes: z.array(mismatchCodeSchema).min(1),
  reason: z.literal("pre_canonical_corrected_reissue"),
}).strict();

const configSchema = z.object({
  schemaVersion: z.literal(1),
  exceptions: z.array(legacyExceptionSchema),
}).strict();

export type CanonicalMoneyLegacyException = z.infer<typeof legacyExceptionSchema>;

export const CANONICAL_MONEY_LEGACY_EXCEPTIONS = configSchema.parse(artifact).exceptions;

export function matchCanonicalMoneyLegacyException(
  evidence: Pick<OrderMoneyReconciliationEvidence,
    "orderId" | "order" | "mismatchCodes" | "invoiceLineageIds">,
  exceptions: readonly CanonicalMoneyLegacyException[] = CANONICAL_MONEY_LEGACY_EXCEPTIONS,
): CanonicalMoneyLegacyException | null {
  return exceptions.find((entry) =>
    evidence.orderId === entry.orderId &&
    evidence.order.amountCents === entry.grossCents &&
    evidence.order.currency === entry.currency &&
    sameStrings(evidence.mismatchCodes, entry.mismatchCodes as OrderMoneyMismatchCode[]) &&
    sameStrings(evidence.invoiceLineageIds.rootInvoiceIds, [entry.rootInvoiceId]) &&
    sameStrings(evidence.invoiceLineageIds.invoiceIds, [entry.rootInvoiceId, entry.replacementInvoiceId]) &&
    evidence.invoiceLineageIds.currentInvoiceId === entry.replacementInvoiceId
  ) ?? null;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}
