import { describe, expect, it } from "vitest";
import { OmnipackProductPayloadError, buildOmnipackProductPayload } from "./omnipackProductPayload.js";

const PACK = { weightGrams: 480, lengthMm: 99, widthMm: 99, heightMm: 110 };

describe("buildOmnipackProductPayload", () => {
  it("builds a product-registration payload with sku, ean, group, name, dimensions", () => {
    const payload = buildOmnipackProductPayload({
      sku: "OPENLUP-DOG-LAMB-CAN-400G",
      ean: "5901234123457",
      productGroup: "BATCH_NR+EXP_DATE",
      title: "openlup Dog Lamb 400g",
      pack: PACK,
    });
    expect(payload).toMatchObject({
      sku: "OPENLUP-DOG-LAMB-CAN-400G",
      ean: "5901234123457",
      group: "BATCH_NR+EXP_DATE",
      name: "openlup Dog Lamb 400g",
      dimensions: { weight: 480, length: 99, width: 99, height: 110 },
    });
  });

  it("rejects a missing EAN (OmniPack matches physical goods by EAN)", () => {
    expect(() =>
      buildOmnipackProductPayload({ sku: "S", ean: null, productGroup: "BATCH_NR+EXP_DATE", title: "T", pack: PACK }),
    ).toThrow(OmnipackProductPayloadError);
  });

  it("rejects a missing pack and missing group/title", () => {
    expect(() =>
      buildOmnipackProductPayload({ sku: "S", ean: "5901234123457", productGroup: "BATCH_NR+EXP_DATE", title: "T", pack: null }),
    ).toThrow(/missing_pack/);
    expect(() =>
      buildOmnipackProductPayload({ sku: "S", ean: "5901234123457", productGroup: "", title: "T", pack: PACK }),
    ).toThrow(/missing_product_group/);
    expect(() =>
      buildOmnipackProductPayload({ sku: "S", ean: "5901234123457", productGroup: "G", title: "  ", pack: PACK }),
    ).toThrow(/missing_title/);
  });

  it("rejects non-positive pack dimensions", () => {
    expect(() =>
      buildOmnipackProductPayload({ sku: "S", ean: "5901234123457", productGroup: "G", title: "T", pack: { ...PACK, weightGrams: 0 } }),
    ).toThrow(/invalid_pack_weight/);
  });
});
