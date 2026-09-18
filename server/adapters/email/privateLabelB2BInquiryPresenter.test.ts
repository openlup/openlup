import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPrivateLabelB2BInquiryPresenter, formatRegion } from "./privateLabelB2BInquiryPresenter.js";

const regionGolden = JSON.parse(readFileSync(new URL("../../../tests/fixtures/public-intake/b2b-notification-regions.json", import.meta.url), "utf8")) as Array<[string, string]>;

describe("private-label B2B inquiry presenter", () => {
  it.each(regionGolden)("keeps exact rendered-region parity for %s", (code, expected) => {
    expect(formatRegion(code)).toBe(expected);
  });

  it("preserves unsupported region codes verbatim", () => {
    expect(formatRegion("zz")).toBe("zz");
  });

  it("preserves the origin-policy refusal before rendering a message", () => {
    const result = createPrivateLabelB2BInquiryPresenter({ EMAIL_ENVIRONMENT: "hidden_preview" }).present({
      request: { company: "Acme", country: "US", firstName: "Jane", lastName: "Smith", email: "jane@acme.test" },
      sourceId: "inq-1",
      notificationTo: ["ops@example.test"],
    });

    expect(result).toEqual({ ok: false, error: "hidden_preview_origin_required" });
  });
});
