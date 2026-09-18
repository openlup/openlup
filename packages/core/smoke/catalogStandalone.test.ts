import { describe, expect, it } from "vitest";
import {
  catalogProductIdSchema,
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
});
