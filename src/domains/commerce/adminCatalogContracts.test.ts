import { describe, expect, it } from "vitest";

import {
  activateCatalogProductRequestSchema,
  archiveCatalogSkuRequestSchema,
  createCatalogDraftRequestSchema,
  setCatalogPriceRequestSchema,
  updateCatalogDraftRequestSchema,
} from "./adminCatalogContracts.js";

const validProduct = {
  slug: "duck",
  name: "Duck recipe",
  species: "dog",
  unit: "can",
  sku: "OPENLUP-DOG-DUCK-CAN-400G",
  netWeightGrams: 400,
  kcalPerUnit: 480,
  allergens: ["duck"],
};

describe("admin catalog write contracts", () => {
  it("accepts a well-formed create-draft and defaults mode to commit", () => {
    const r = createCatalogDraftRequestSchema.safeParse({ product: validProduct });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.mode).toBe("commit");
  });

  it("accepts dry_run mode + an idempotency key", () => {
    const r = createCatalogDraftRequestSchema.safeParse({
      mode: "dry_run",
      idempotencyKey: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      product: validProduct,
    });
    expect(r.success).toBe(true);
  });

  it("rejects a malformed slug and an unknown field (strict)", () => {
    expect(
      createCatalogDraftRequestSchema.safeParse({ product: { ...validProduct, slug: "Bad Slug!" } }).success,
    ).toBe(false);
    expect(
      createCatalogDraftRequestSchema.safeParse({ product: { ...validProduct, surprise: 1 } }).success,
    ).toBe(false);
    expect(
      createCatalogDraftRequestSchema.safeParse({ product: validProduct, extra: true }).success,
    ).toBe(false);
  });

  it("rejects a bad idempotency key (must be uuid)", () => {
    expect(
      createCatalogDraftRequestSchema.safeParse({ idempotencyKey: "nope", product: validProduct }).success,
    ).toBe(false);
  });

  it("requires at least one field on update-draft", () => {
    expect(updateCatalogDraftRequestSchema.safeParse({ slug: "duck", updates: {} }).success).toBe(false);
    expect(
      updateCatalogDraftRequestSchema.safeParse({ slug: "duck", updates: { kcalPerUnit: 500 } }).success,
    ).toBe(true);
  });

  it("validates set-price / archive / activate shapes", () => {
    expect(
      setCatalogPriceRequestSchema.safeParse({
        sku: "OPENLUP-DOG-DUCK-CAN-400G",
        price: { mode: "one_time", unitPriceMinor: 1490, currency: "PLN" },
      }).success,
    ).toBe(true);
    expect(archiveCatalogSkuRequestSchema.safeParse({ sku: "OPENLUP-DOG-DUCK-CAN-400G" }).success).toBe(true);
    expect(activateCatalogProductRequestSchema.safeParse({ slug: "duck" }).success).toBe(true);
    // negative unit price rejected
    expect(
      setCatalogPriceRequestSchema.safeParse({
        sku: "OPENLUP-DOG-DUCK-CAN-400G",
        price: { mode: "one_time", unitPriceMinor: -1, currency: "PLN" },
      }).success,
    ).toBe(false);
  });
});
