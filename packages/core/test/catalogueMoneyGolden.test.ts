import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { evaluatePromotionAdjustmentsV2 } from "../src/promo/index.js";
import { allocateCatalogueDiscountedGrossTotals, cataloguePositionNetFromGross } from "../src/pricing/index.js";

const decimal = z.string().regex(/^(0|[1-9]\d*)$/).refine(value => Number.isSafeInteger(Number(value)));
const minor = decimal.transform(Number);
const text = z.string().min(1);
const moneyLine = z.object({ grossMinor: minor, netMinor: minor, vatMinor: minor, vatRateBps: minor }).strict();
const scope = z.enum(["one_time", "subscription_initial"]);
const candidateFields = {
  promotionId: text, name: text, lane: z.literal("product"), kind: z.literal("target_percentage"),
  valueBps: minor, scopes: z.array(scope).min(1),
};
const candidate = z.discriminatedUnion("source", [
  z.object({ ...candidateFields, source: z.literal("automatic") }).strict(),
  z.object({ ...candidateFields, source: z.literal("code"), codeId: text, code: text }).strict(),
]);
const metadata = {
  id: text, ruleRef: text,
  donor: z.object({
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    location: z.string().regex(/^[\w/.-]+\.ts:\d+(?:-\d+)?$/),
    witness: z.string().regex(/^[\w/.-]+\.test\.ts:.+$/),
  }).strict(),
};
const rowSchema = z.discriminatedUnion("operation", [
  z.object({ ...metadata, kind: z.literal("quote_money"), operation: z.literal("included_vat"),
    input: z.object({ grossMinor: minor, vatRateBps: minor }).strict(),
    expected: z.object({ netMinor: minor, vatMinor: minor }).strict(),
  }).strict(),
  z.object({ ...metadata, kind: z.literal("quote_money"), operation: z.literal("position_net"),
    input: z.object({ grossMinor: minor, vatRateBps: minor, vatRate: text }).strict(),
    expected: z.object({ netMinor: minor }).strict(),
  }).strict(),
  z.object({ ...metadata, kind: z.literal("quote_money"), operation: z.literal("discount_allocation"),
    input: z.object({ lineTotalsMinor: z.array(minor).min(1), chargedTotalMinor: minor,
      lineKeys: z.array(text).optional() }).strict(),
    expected: z.object({ linePayablesMinor: z.array(minor).min(1) }).strict(),
  }).strict(),
  z.object({ ...metadata, kind: z.literal("promotion"), operation: z.literal("promotion_v2"),
    input: z.object({
      context: z.object({ purchaseScope: scope, referenceProductMinor: minor, currentProductMinor: minor,
        shippingMinor: minor, minimumProductPayableMinor: minor }).strict(),
      candidates: z.array(candidate).min(1),
    }).strict(),
    expected: z.object({ productPayableMinor: minor, shippingPayableMinor: minor, effectiveProductDiscountBps: minor,
      adjustments: z.array(z.object({ promotionId: text, source: z.enum(["automatic", "code"]),
        amountOffMinor: minor, floorApplied: z.boolean() }).strict()),
      rejectedCodes: z.array(z.object({ codeId: text, code: text, reason: z.literal("better_price_exists") }).strict()),
    }).strict(),
  }).strict(),
  z.object({ ...metadata, kind: z.literal("quote_money"), operation: z.literal("legacy_quote"),
    input: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), lines: z.array(moneyLine).min(1),
      grossMinor: minor, netMinor: minor, vatMinor: minor }).strict(),
    expected: z.object({ success: z.literal(false), issue: z.object({ path: z.array(text), message: text }).strict() }).strict(),
  }).strict(),
]);
const fixtureSchema = z.object({ version: z.literal("1"), rows: z.array(rowSchema).min(1) }).strict()
  .refine(fixture => new Set(fixture.rows.map(row => row.id)).size === fixture.rows.length, "duplicate row id");
const raw: unknown = JSON.parse(readFileSync(new URL("./fixtures/catalogue-money.v1.json", import.meta.url), "utf8"));
const { rows } = fixtureSchema.parse(raw);
const rawRows = z.object({ rows: z.array(z.record(z.string(), z.unknown())) }).parse(raw).rows;

describe("catalogue money golden fixture admission (L1)", () => {
  it("admits versioned shapes, decimal strings, unique ids and donor citations", () => {
    expect(fixtureSchema.safeParse(raw).success).toBe(true);
  });

  it.each([
    ["unknown operation", { ...rawRows[0], operation: "unknown" }],
    ["missing donor", { ...rawRows[0], donor: undefined }],
    ["missing witness", { ...rawRows[0], donor: { ...rows[0].donor, witness: "" } }],
    ["numeric amount", { ...rawRows[0], input: { grossMinor: 12300, vatRateBps: "2300" } }],
  ])("refuses %s", (_name, row) => {
    expect(rowSchema.safeParse(row).success).toBe(false);
  });

  it("refuses duplicate ids", () => {
    const source = JSON.parse(readFileSync(new URL("./fixtures/catalogue-money.v1.json", import.meta.url), "utf8"));
    source.rows.push(source.rows[0]);
    expect(fixtureSchema.safeParse(source).success).toBe(false);
  });
});

describe("catalogue money V2 promotion owners (L2)", () => {
  it.each(rows.filter(row => row.operation === "promotion_v2"))("$id", row => {
    const result = evaluatePromotionAdjustmentsV2(row.input.context, row.input.candidates);
    expect({
      productPayableMinor: result.productPayableMinor,
      shippingPayableMinor: result.shippingPayableMinor,
      effectiveProductDiscountBps: result.effectiveProductDiscountBps,
      adjustments: result.adjustments.map(({ promotionId, source, amountOffMinor, floorApplied }) =>
        ({ promotionId, source, amountOffMinor, floorApplied })),
      rejectedCodes: result.rejectedCodes,
    }).toEqual(row.expected);
  });
});

describe("catalogue money position owners (L2)", () => {
  it.each(rows.filter(row => row.operation === "included_vat" || row.operation === "position_net"))("$id", row => {
    expect(cataloguePositionNetFromGross(row.input.grossMinor, row.input.vatRateBps)).toBe(row.expected.netMinor);
  });

  it.each(rows.filter(row => row.operation === "discount_allocation"))("$id", row => {
    const actual = allocateCatalogueDiscountedGrossTotals(row.input.lineTotalsMinor, row.input.chargedTotalMinor);
    expect(actual).toEqual(row.expected.linePayablesMinor);
    if (row.input.lineKeys) {
      expect(row.input.lineKeys.map((key, index) => [key, actual[index]]))
        .toEqual(row.input.lineKeys.map((key, index) => [key, row.expected.linePayablesMinor[index]]));
    }
  });
});
