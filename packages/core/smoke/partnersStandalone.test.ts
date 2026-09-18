import { describe, expect, it } from "vitest";
import {
  partnersB2BInquiryStatusSchema,
  partnersB2BInquiryStatusUpdateRequestSchema,
  partnersB2BInquiryStatusUpdateResponseSchema,
  type PartnersB2BInquiryStatusUpdatePort,
} from "@openlup/core/partners";

describe("partners standalone surface", () => {
  it("validates neutral partner inquiry status updates", () => {
    expect(partnersB2BInquiryStatusSchema.parse("qualified")).toBe("qualified");
    expect(
      partnersB2BInquiryStatusUpdateRequestSchema.parse({
        id: "inquiry-001",
        status: "closed_won",
      }),
    ).toEqual({
      id: "inquiry-001",
      status: "closed_won",
    });

    expect(
      partnersB2BInquiryStatusUpdateRequestSchema.safeParse({
        id: "inquiry-001",
        status: "needs_callback",
      }).success,
    ).toBe(false);
  });

  it("keeps the status update port structural", async () => {
    const port: PartnersB2BInquiryStatusUpdatePort = {
      async updateB2BInquiryStatus(request) {
        expect(request.status).toBe("contacted");
        return { updated: true };
      },
    };

    await expect(
      port.updateB2BInquiryStatus(
        partnersB2BInquiryStatusUpdateRequestSchema.parse({
          id: "inquiry-002",
          status: "contacted",
        }),
      ),
    ).resolves.toEqual(partnersB2BInquiryStatusUpdateResponseSchema.parse({ updated: true }));
  });
});
