import { describe, expect, it } from "vitest";
import { mapLegacyGetDhlLabelResponse } from "../../../adapters/dhl/labelsAdapter.js";

describe("DHL label BFF route adapter", () => {
  it("maps legacy Edge Function fields to the typed fulfillment contract", () => {
    expect(mapLegacyGetDhlLabelResponse({ label_url: "https://cdn.example/TRK-1.pdf" }))
      .toEqual({ labelUrl: "https://cdn.example/TRK-1.pdf" });
  });
});
