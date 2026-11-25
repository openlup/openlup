import { z } from "zod";
import {
  commerceMoneyV2DeliveryBucketSchema as bucket,
  commerceMoneyV2CurrencySchema as currency,
  commerceMoneyV2DigestSchema as digest,
  commerceMoneyV2PromotionEngineSchema as engine,
  commerceMoneyV2TaxEvidenceShape as evidence,
  commerceMoneyV2FactsSchema as factsShape,
  commerceMoneyV2FeeLineSchema as feeLine,
  commerceMoneyV2LineSchema as line,
  commerceMoneyV2MinorSchema as minor,
  commerceMoneyV2PriceSchema as price,
  commerceMoneyV2ReferenceSchema as ref,
  commerceMoneyV2UuidSchema as uuid,
} from "../../pricing/index.js";
import type { ErasedPaidOrderMoneyV2, PaidOrderMoneyV2 } from "../contracts/orderMoneyV2.js";

const captureMismatch = "paid_order_money_capture_mismatch";
const invalidInput = "paid_order_money_invalid_input";
const unavailable = "paid_order_money_read_unavailable";
const moneyRemedy = "The applied capture amount or currency differs from the sealed order money. Keep the sealed money and do not re-quote. Hold receipt and fiscal effects and refer the capture to the payment owner to resolve the discrepancy. Automatic recovery is not supported by this version.";
const captureRemedies = {
  "/captureEvidenceRef": "The order's applied capture is not bound to exactly one verified capture record. Hold receipt and fiscal effects for this order and refer it to the payment owner to recover the original capture record. A new provider readback does not repair this binding. Automatic recovery is not supported by this version.",
  "/captureRoute": "The order's applied capture came through a payment route whose capture evidence this reader does not verify. Hold receipt and fiscal effects for this order. Paid money for this route is not supported by this version.",
  "/paidMinor": moneyRemedy,
  "/currency": moneyRemedy,
} as const;

const payable = minor.min(1).max(2_147_483_647);
const paidFacts = z.strictObject({
  ...factsShape.shape, currency, price, lines: z.array(line).min(1).max(50), feeLines: z.array(feeLine).max(256),
  netTotal: minor, taxTotal: minor, feeTotal: minor, payableMinor: payable,
  orderId: uuid, moneyVersion: z.literal("commerce.order-money.v2"), schemaVersion: z.literal(2), acceptedMoneyDigest: digest,
  acceptedQuoteRef: z.strictObject({ quoteId: uuid, quoteDigest: digest, acceptanceRef: ref, tokenDigest: digest }),
  intentId: uuid, captureEvidenceRef: uuid, capturedAt: z.iso.datetime({ precision: 3 }), paidMinor: payable,
});
const live = paidFacts.extend({ deliverySelectionRef: ref, deliveryBuckets: z.array(bucket).max(256) });
const erased = paidFacts.extend({
  destination: z.strictObject({ snapshotRef: uuid, schemaVersion: z.literal(2), erased: z.literal(true) }),
  deliveryBuckets: z.array(bucket.omit({ carrierRef: true, serviceRef: true })).max(256),
});
const inclusive = {
  amountBasis: z.literal("inclusive"),
  promotion: z.strictObject({ engine, rankingRuleRef: z.literal("lowest_payable_gross") }),
  taxEvidence: z.strictObject({ ...evidence, kind: z.literal("fiscal_profile") }),
};
const exclusive = {
  amountBasis: z.literal("exclusive"),
  promotion: z.strictObject({ engine, rankingRuleRef: z.literal("lowest_pre_tax.v1") }),
  taxEvidence: z.strictObject({ ...evidence, kind: z.literal("tax_calculation") }),
};

const money = z.union([
  z.discriminatedUnion("amountBasis", [live.extend(inclusive), live.extend(exclusive)]),
  z.discriminatedUnion("amountBasis", [erased.extend(inclusive), erased.extend(exclusive)]),
]) satisfies z.ZodType<PaidOrderMoneyV2 | ErasedPaidOrderMoneyV2>;
const envelope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("paid"), money }),
  z.strictObject({ kind: z.literal("refused"), code: z.literal(captureMismatch), field: z.enum(Object.keys(captureRemedies) as (keyof typeof captureRemedies)[]) }),
]).nullable();

type QueryExecutor = { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

/** @experimental Read the sealed order money and its original bound capture from native PostgreSQL. */
export async function readPaidOrderMoneyV2(db: QueryExecutor, orderId: string): Promise<PaidOrderMoneyV2 | ErasedPaidOrderMoneyV2 | null> {
  const input = uuid.safeParse(orderId);
  if (!input.success) {
    throw Object.assign(new Error(invalidInput), {
      code: invalidInput, field: "/orderId", remedy: "Pass the order's canonical lowercase UUID.",
    });
  }

  let result: z.output<typeof envelope>;
  try {
    const { rows } = await db.query("SELECT public.commerce_read_paid_order_money_v2($1::uuid) AS value", [input.data]);
    if (rows.length !== 1 || !Object.hasOwn(rows[0]!, "value")) throw new Error("Expected one paid money result.");
    result = envelope.parse(rows[0]!.value);
  } catch (cause) {
    throw Object.assign(new Error(unavailable, { cause }), {
      code: unavailable, field: "/read",
      remedy: "Check the native app binding, driver setup, database connection and TLS, EXECUTE on the paid money reader, and installed migrations. Then retry the same read.",
    });
  }

  if (result === null) return null;
  if (result.kind === "refused") {
    throw Object.assign(new Error(result.code), { code: result.code, field: result.field, remedy: captureRemedies[result.field] });
  }
  return result.money;
}
