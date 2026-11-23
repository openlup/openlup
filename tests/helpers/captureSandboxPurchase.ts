import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { CreateQuoteResponse } from "@openlup/platform/pricing";
import type { SandboxPaymentSimulator } from "@openlup/platform/payments/contracts";

/** Create a purchase on a historical prefix that predates catalogue admission. */
export async function createHistoricalPurchaseDraft(db: Pool, key: string, quoteSnapshot: CreateQuoteResponse, clientId: string) {
  const { quote, contractVersion } = quoteSnapshot;
  const { currency, taxIncluded, lines, discounts, context, subtotalGross, discountTotalGross,
    shippingGross, shippingDiscountGross, totalGross, netTotal, taxTotal } = quote;
  const draft = { contractVersion, source: "commerce.order_draft.bff.v0", status: "draft", paymentStatus: "not_started",
    currency, taxIncluded, lines, discounts, context,
    totals: { subtotalGross, discountTotalGross, shippingGross, shippingDiscountGross, totalGross, netTotal, taxTotal } };
  const { rows: [row] } = await db.query<{ result: { orderDraft: { orderId: string } } }>(
    "SELECT public.commerce_create_promoted_order_draft_with_outbox($1,$2,$3,$4) AS result",
    [key, quoteSnapshot, draft, clientId],
  );
  return row!.result.orderDraft.orderId.replace(/^order_/, "");
}

/** Capture fixture purchases through the simulator's durable observation and verified ingress. */
export async function captureSandboxPurchase(simulator: SandboxPaymentSimulator,
  input: { settlementIntentId: string; key: string; at: string }) {
  const attempt = await simulator.beginAttempt({ settlementIntentId: input.settlementIntentId,
    idempotencyKey: `purchase-attempt:${input.key}`, requestFingerprint: createHash("sha256").update(input.key).digest("hex"), at: input.at });
  const observation = await simulator.recordObservation({ attemptId: attempt.id,
    idempotencyKey: `purchase-observation:${input.key}`, outcome: "captured", occurredAt: input.at });
  return simulator.ingress.receive({ rawBody: new TextEncoder().encode(JSON.stringify({
    settlementIntentId: input.settlementIntentId, attemptId: attempt.id, observationId: observation.id })), headers: {}, receivedAt: input.at });
}
