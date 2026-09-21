import { describe, expect, it } from "vitest";
import {
  catalogProductIdSchema,
  catalogSlugFormat,
  skuSchema,
  slugSchema,
  variantIdSchema,
} from "@openlup/core/catalog";

describe("catalog identifier standalone smoke", () => {
  it("accepts neutral open identifiers by format", () => {
    expect(slugSchema.safeParse("example-product").success).toBe(true);
    expect(skuSchema.safeParse("CORE-SKU-ALPHA.v1").success).toBe(true);
    expect(catalogProductIdSchema.safeParse("f47ac10b-58cc-4372-a567-0e02b2c3d479").success).toBe(true);
    expect(variantIdSchema.safeParse("variant_alpha_001").success).toBe(true);
  });

  it("rejects malformed identifier shapes", () => {
    expect(slugSchema.safeParse("Example Product").success).toBe(false);
    expect(skuSchema.safeParse("bad sku").success).toBe(false);
    expect(catalogProductIdSchema.safeParse("-bad").success).toBe(false);
    expect(variantIdSchema.safeParse("bad id").success).toBe(false);
  });

  it("rejects a slug carrying whitespace rather than normalising it", () => {
    for (const candidate of [" example", "example ", "\texample", "ex ample"]) {
      expect(slugSchema.safeParse(candidate).success).toBe(false);
    }
  });

  // Both exports are published, so a caller may pre-check with the format and
  // parse with the schema. No sample exceeds the maximum length, which the format
  // deliberately does not encode; the empty string is rejected by both.
  it("agrees with the published slug format on every sample", () => {
    for (const candidate of [
      "example-product",
      "example",
      "example_variant",
      "example-7",
      " example",
      "example ",
      "\texample",
      "ex ample",
      "Example Product",
      "-leading",
      "",
    ]) {
      expect(slugSchema.safeParse(candidate).success).toBe(catalogSlugFormat.test(candidate));
    }
  });
});
