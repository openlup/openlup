import { readFileSync } from "node:fs";
import * as priceSetup from "../../src/pricing/catalogPriceSetupSchemas.js";
import { draftBasisPriceIssue } from "../../src/catalog/publicationIntent.js";
import { catalogDraftCommandV4Schema } from "../../src/catalog/lifecycleDraftSchemas.js";
import { canonicalCatalogDraftJson } from "../../src/catalog/contracts/draft.js";
import { describe, expect, it } from "vitest";
import {
  canonicalCatalogPriceSetupCommand,
  catalogPriceSetupApplyResultSchema,
  catalogPriceSetupCommandSchema,
  catalogPriceSetupPreviewResultSchema,
} from "../../src/pricing/catalogPriceSetupSchemas.js";

const variantId = "10000000-0000-4000-8000-000000000001";
const priceListId = "20000000-0000-4000-8000-000000000001";
const entryId = "30000000-0000-4000-8000-000000000001";
const actorId = "40000000-0000-4000-8000-000000000001";
const command = {
  schemaVersion: 1, commandKey: "change-1", variantId, priceListId,
  mode: "one_time", minQty: 1, amountKind: "gross", unitPriceMinor: 1200,
  expected: { entryId, unitPriceMinor: 1000 },
};
const entry = { entryId, unitPriceMinor: 1000, validFrom: "2026-09-30T10:00:00.123456+00:00" };

describe("catalog price setup contracts", () => {
  it("accepts one gross one-time base at minimum quantity one, with or without a previous base", () => {
    expect(catalogPriceSetupCommandSchema.safeParse(command).success).toBe(true);
    expect(catalogPriceSetupCommandSchema.safeParse({
      ...command, expected: { entryId: null, unitPriceMinor: null },
    }).success).toBe(true);
  });

  it.each([
    ["a subscription price", { mode: "subscription" }],
    ["a quantity tier", { minQty: 2 }],
    ["a net amount", { amountKind: "net" }],
    ["a zero amount", { unitPriceMinor: 0 }],
    ["a fractional amount", { unitPriceMinor: 12.5 }],
    ["an amount above the column maximum", { unitPriceMinor: 2_147_483_648 }],
    ["an uppercase UUID", { variantId: "A0000000-0000-4000-8000-00000000000B" }],
    ["an untrimmed command key", { commandKey: " change-1" }],
    ["an unknown key", { note: "extra" }],
    ["a half-null expected state", { expected: { entryId: null, unitPriceMinor: 1000 } }],
    ["an incomplete expected state", { expected: { entryId } }],
  ])("refuses %s", (_label, change) => {
    expect(catalogPriceSetupCommandSchema.safeParse({ ...command, ...change }).success).toBe(false);
    expect(() => canonicalCatalogPriceSetupCommand({ ...command, ...change })).toThrow();
  });

  it("encodes a command as sorted, stable JSON whatever the input key order", () => {
    const canonical = canonicalCatalogPriceSetupCommand(command);
    expect(canonicalCatalogPriceSetupCommand(Object.fromEntries(Object.entries(command).reverse()))).toBe(canonical);
    expect(canonical).toBe(
      `{"amountKind":"gross","commandKey":"change-1","expected":{"entryId":"${entryId}","unitPriceMinor":1000},`
      + `"minQty":1,"mode":"one_time","priceListId":"${priceListId}","schemaVersion":1,`
      + `"unitPriceMinor":1200,"variantId":"${variantId}"}`,
    );
  });

  it("reads committed and replayed receipts and bounded refusals as the apply result", () => {
    const receipt = { commandKey: "change-1", variantId, priceListId, actorId, previous: null, current: entry };
    expect(catalogPriceSetupApplyResultSchema.safeParse({ outcome: "committed", receipt }).success).toBe(true);
    expect(catalogPriceSetupApplyResultSchema.safeParse({
      outcome: "replayed", receipt: { ...receipt, previous: entry },
    }).success).toBe(true);
    expect(catalogPriceSetupApplyResultSchema.safeParse({
      outcome: "validation_issue", reason: "readiness_would_fail", reasons: ["promotion_watchdog_not_ready"],
    }).success).toBe(true);
    expect(catalogPriceSetupApplyResultSchema.safeParse({
      outcome: "committed", receipt: { ...receipt, extra: true },
    }).success).toBe(false);
    expect(catalogPriceSetupApplyResultSchema.safeParse({ outcome: "applied", receipt }).success).toBe(false);
    expect(catalogPriceSetupApplyResultSchema.safeParse({ outcome: "conflict", reason: "Free text" }).success).toBe(false);
  });

  it("reads every subscription price source a preview reports", () => {
    const preview = {
      outcome: "preview", variantId, priceListId, inGate: true, current: entry, currentCount: 1,
      readiness: { ready: false, reasons: ["promotion_watchdog_not_ready"] },
    };
    for (const subscription of [
      { kind: "derived", revisionId: entryId, discountBps: 1000, roundingQuantumMinor: 10, derivedUnitPriceMinor: 900 },
      { kind: "derived", revisionId: entryId, discountBps: 1000, roundingQuantumMinor: 10, derivedUnitPriceMinor: null },
      { kind: "stored", unitPriceMinor: 900 },
      { kind: "unresolved", reason: "subscription_policy_ambiguous" },
    ]) {
      expect(catalogPriceSetupPreviewResultSchema.safeParse({ ...preview, subscription }).success).toBe(true);
    }
    expect(catalogPriceSetupPreviewResultSchema.safeParse({
      ...preview, subscription: { kind: "stored" },
    }).success).toBe(false);
  });
});

const corpus = JSON.parse(readFileSync(new URL("../fixtures/catalogPriceSetupV2.json", import.meta.url), "utf8"));
const priceV2Vectors: readonly [string, object, string?][] = corpus.vectors;
const priceDraft = (change: object = {}) => {
  const draft = structuredClone(corpus.draft);
  const price = Object.assign(draft.payload.skus[0].priceOperations[0], change);
  const context = draft.payload.publication.evidence.priceContext;
  context.amountBasis = price.expectedListAmountBasis;
  if (price.expectedListAmountBasis === "tax_inclusive") context.tax = null;
  return draft;
};

describe("governed draft v4 basis price input", () => {
  it.each(priceV2Vectors)("checks %s at the pricing and draft boundaries", (_label, change, reason) => {
    const command = priceDraft(change).payload.skus[0].priceOperations[0];
    if (reason) expect(() => priceSetup.canonicalCatalogPriceSetupCommandV2(command)).toThrow(expect.any(Error));
    else expect(JSON.parse(priceSetup.canonicalCatalogPriceSetupCommandV2(command))).toEqual(command);
    expect(catalogDraftCommandV4Schema.safeParse(priceDraft(change)).success).toBe(!reason);
  });

  it("identifies the field and repair for a refused saved amount", () => {
    expect(draftBasisPriceIssue(priceDraft({ unitPriceMinor: 0 }).payload)).toEqual({
      code: "money_amount_out_of_range",
      path: "skus.0.priceOperations.0.unitPriceMinor",
      message: "1–2147483647. Wpisz w oznaczonym polu całkowitą kwotę w jednostkach minor z podanego zakresu, zapisz nową rewizję i uruchom Prepare.",
    });
  });

  it("keeps the TypeScript Save depth boundary and the previously admitted draft", () => {
    expect(catalogDraftCommandV4Schema.safeParse(corpus.legacy).success).toBe(true);
    const draft = priceDraft();
    for (const depth of [48, 49]) {
      draft.payload.product.sharedContent.presentation = { nested: Array.from({ length: depth - 5 })
        .reduce<object>(value => [value], {}) };
      if (depth === 48) expect(() => canonicalCatalogDraftJson(draft)).not.toThrow();
      else expect(() => canonicalCatalogDraftJson(draft)).toThrow("draft_json_depth");
    }
  });
});
