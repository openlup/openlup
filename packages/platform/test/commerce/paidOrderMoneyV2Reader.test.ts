import { describe, expect, it, vi } from "vitest";
import { readPaidOrderMoneyV2 } from "../../src/commerce/server/paidOrderMoneyV2.js";

const orderId = "81a88fd7-b88b-4c84-adea-77344d1e3360";
const digest = "a".repeat(64);
const capturedAt = "2026-06-05T10:00:00.123Z";
const captureCode = "paid_order_money_capture_mismatch";

function envelope(erased: boolean) {
  const position = { positionRef: "position", jurisdictionRef: "district", level: "district", taxKind: "sale",
    taxabilityReason: "registered", ruleRef: "rule", resolutionDigest: digest, rateDecimal: "0",
    providerLineRef: "provider-line", taxableMinor: 1, taxMinor: 0,
    resolution: { assignmentRef: "assignment", policyRevision: "revision", sourceRef: "source",
      sourceDigest: digest, effective: { from: capturedAt, until: "2026-07-05T10:00:00.123Z" } } };
  const state = { basisMinor: 1, netMinor: 1, taxMinor: 0, taxPositions: [position] };
  const component = () => structuredClone({
    preDiscountMinor: 2, effectiveMinor: 1, netMinor: 1, taxMinor: 0, lineTotalMinor: 1, taxPositions: [position],
    discountAllocations: [{ allocationId: orderId, adjustmentRef: "adjustment", sequence: 1, source: "legacy_promotion",
      basisReductionMinor: 1, netReductionMinor: 1, taxReductionMinor: 0, evidenceRef: "evidence", before: state, after: state }],
  });
  return { kind: "paid", money: {
    orderId, moneyVersion: "commerce.order-money.v2", schemaVersion: 2, acceptedMoneyDigest: digest,
    acceptedQuoteRef: { quoteId: orderId, quoteDigest: digest, acceptanceRef: "acceptance", tokenDigest: digest },
    intentId: orderId, captureEvidenceRef: orderId, capturedAt, paidMinor: 4,
    amountBasis: "inclusive", currency: "XXX", mode: "subscription", catalogueEvidenceRef: "catalogue",
    cadence: { schemaVersion: 1, kind: "fixed_days", days: 30 },
    destination: erased ? { snapshotRef: orderId, schemaVersion: 2, erased: true }
      : { snapshotRef: orderId, schemaVersion: 2, destinationDigest: digest, policyRevision: "revision" },
    ...(erased ? {} : { deliverySelectionRef: "delivery" }),
    coverageDigest: digest, netTotal: 2, taxTotal: 0, feeTotal: 2, payableMinor: 4,
    price: { priceListRef: "list", priceContextDigest: digest, priceEvidenceRef: "price", classMapRevision: "revision" },
    promotion: { engine: "promotion-engine.v1", rankingRuleRef: "lowest_payable_gross" },
    taxEvidence: { kind: "fiscal_profile", calculationId: orderId, evidenceDigest: digest, taxDate: capturedAt,
      expiresAt: "2026-07-05T10:00:00.123Z" },
    paymentLimits: { profileRef: "profile", revision: "1", channelKey: "channel", currency: "XXX", minMinor: 1, maxMinor: 100 },
    lines: [{ ...component(), lineKey: "line", sourceOrdinal: 1, sku: "article", mode: "subscription", quantity: 1,
      unitBasisMinor: 2, taxClassKey: "class", assignmentRef: "assignment" }],
    deliveryBuckets: [{ bucketKey: "bucket", kind: "shipping", taxClassKey: "class", assignmentRef: "assignment",
      ...(erased ? {} : { carrierRef: "carrier", serviceRef: "service" }), separatelyStated: true,
      cost: { ref: "cost", currency: "XXX", amountMinor: 2 }, parts: [{ ...component(), sourceOrdinal: 1 }] }],
    feeLines: ["order", "delivery"].map(kind => ({ feeKey: kind, jurisdictionRef: "district", feeKind: "fee", amountMinor: 1,
      scope: kind === "order" ? { kind } : { kind, bucketKey: "bucket" }, refundRule: { ref: "rule", revision: "revision" } })),
  } };
}

const executor = (value: unknown) => ({ query: vi.fn(async () => ({ rows: [{ value }] })) });
function caught(result: Promise<unknown>) {
  return result.then(() => { throw new Error("Expected refusal"); }, (error: Error) => error);
}
const unavailable = {
  message: "paid_order_money_read_unavailable", code: "paid_order_money_read_unavailable", field: "/read",
  remedy: "Check the native app binding, driver setup, database connection and TLS, EXECUTE on the paid money reader, and installed migrations. Then retry the same read.",
};
function exactError(error: Error, fields: { message: string; code: string; field: string; remedy: string }, infra = false) {
  expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
  expect(Reflect.ownKeys(error).filter(key => key !== "stack").sort()).toEqual(
    [...Object.keys(fields), ...(infra ? ["cause"] : [])].sort());
  expect(error).toMatchObject(fields);
}

it.each([null, undefined, 1, {}, new String(orderId), orderId.toUpperCase(), orderId + "\n", orderId.replaceAll("-", "")])(
  "refuses invalid order IDs before querying", async input => {
    const db = executor(null);
    exactError(await caught(readPaidOrderMoneyV2(db, input as string)), {
      message: "paid_order_money_invalid_input", code: "paid_order_money_invalid_input", field: "/orderId",
      remedy: "Pass the order's canonical lowercase UUID.",
    });
    expect(db.query).not.toHaveBeenCalled();
  });

it("issues one parameterized call for a canonical UUID and accepts SQL NULL", async () => {
  const db = executor(null);
  await expect(readPaidOrderMoneyV2(db, orderId)).resolves.toBeNull();
  expect(db.query).toHaveBeenCalledExactlyOnceWith("SELECT public.commerce_read_paid_order_money_v2($1::uuid) AS value", [orderId]);
});

const binding = "The order's applied capture is not bound to exactly one verified capture record. Hold receipt and fiscal effects for this order and refer it to the payment owner to recover the original capture record. A new provider readback does not repair this binding. Automatic recovery is not supported by this version.";
const money = "The applied capture amount or currency differs from the sealed order money. Keep the sealed money and do not re-quote. Hold receipt and fiscal effects and refer the capture to the payment owner to resolve the discrepancy. Automatic recovery is not supported by this version.";

it.each([
  ["/captureEvidenceRef", binding],
  ["/captureRoute", "The order's applied capture came through a payment route whose capture evidence this reader does not verify. Hold receipt and fiscal effects for this order. Paid money for this route is not supported by this version."],
  ["/paidMinor", money], ["/currency", money],
])("returns the exact capture refusal for %s", async (field, remedy) => {
  exactError(await caught(readPaidOrderMoneyV2(executor({ kind: "refused", code: captureCode, field }), orderId)),
    { message: captureCode, code: captureCode, field, remedy });
});

it("retains a driver failure as a non-enumerable cause", async () => {
  const cause = new Error("fixture transport failure");
  const error = await caught(readPaidOrderMoneyV2({ query: vi.fn().mockRejectedValue(cause) }, orderId));
  exactError(error, unavailable, true);
  expect(Object.getOwnPropertyDescriptor(error, "cause")).toMatchObject({ value: cause, enumerable: false });
});

function objects(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value)) return value.flatMap((item, index) => objects(item, [...path, index]));
  if (value === null || typeof value !== "object") return [];
  return [path, ...Object.entries(value).flatMap(([key, item]) => objects(item, [...path, key]))];
}

describe.each([false, true])("paid envelope with erased=%s", erased => {
  it("returns the exact accepted shape and digest", async () => {
    const value = envelope(erased);
    await expect(readPaidOrderMoneyV2(executor(value), orderId)).resolves.toStrictEqual(value.money);
  });

  it.each(objects(envelope(erased)).map(path => ({ label: "/" + path.join("/"), path })))(
    "refuses forbidden fields at $label", async ({ path }) => {
      for (const field of ["email", "line1"]) {
        const value = envelope(erased);
        const target = path.reduce<Record<string | number, unknown>>(
          (record, key) => record[key] as Record<string | number, unknown>, value);
        target[field] = "forbidden";
        exactError(await caught(readPaidOrderMoneyV2(executor(value), orderId)), unavailable, true);
      }
    });

  it.each(["quoteId", "quoteDigest", "status", "moneyDigest", "contractVersion", "cycleBindingRef"])(
    "refuses the foreign money field %s", async key => {
      const value = envelope(erased);
      Object.assign(value.money, { [key]: digest });
      exactError(await caught(readPaidOrderMoneyV2(executor(value), orderId)), unavailable, true);
    });
});

it.each([undefined, [], { kind: "refused", code: captureCode, field: "/other" },
  { kind: "refused", code: captureCode, field: "/paidMinor", expected: 2 }])(
  "refuses a malformed envelope", async value => {
    exactError(await caught(readPaidOrderMoneyV2(executor(value), orderId)), unavailable, true);
  });

it("requires a single result row", async () => {
  for (const rows of [[], [{ value: null }, { value: null }]]) {
    exactError(await caught(readPaidOrderMoneyV2({ query: async () => ({ rows }) }, orderId)), unavailable, true);
  }
});
