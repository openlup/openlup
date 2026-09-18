import { describe, expect, it } from "vitest";
import { mapLegacyMergeDhlLabelsResponse } from "../../../adapters/dhl/labelsAdapter.js";

describe("admin DHL merge labels BFF route adapters", () => {
  it("maps legacy merge labels response into the BFF contract", () => {
    expect(mapLegacyMergeDhlLabelsResponse({ pdf_base64: "PDFDATA", label_count: 2 }))
      .toEqual({ pdfBase64: "PDFDATA", labelCount: 2 });
  });
});
