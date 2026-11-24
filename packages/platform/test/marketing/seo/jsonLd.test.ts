import { expect, it } from "vitest";
import { catalogInternalGtin } from "../../../src/catalog/index.js";
import { productLd } from "../../../src/marketing/seo/jsonLd.js";

const origin = "https://example.invalid";
const product = { url: `${origin}/item`, name: "Example Item", inLanguage: "en", brandName: "Example Brand", images: [] };

it("internal_gtin_is_not_emitted_as_gtin13", () => {
  expect(productLd(origin, { ...product, gtin13: catalogInternalGtin(1) })).toEqual(productLd(origin, product));
});

it.each(["0200000000004", "2000000000008", "2900000000001"])("regional_rcn_is_not_emitted_as_gtin13 (%s)", (value) => {
  expect(productLd(origin, { ...product, gtin13: value })).toEqual(productLd(origin, product));
});

it("real_gtin_still_emitted", () => {
  expect(productLd(origin, { ...product, gtin13: "5901234123457" })).toEqual({
    ...productLd(origin, product), gtin13: "5901234123457",
  });
});
