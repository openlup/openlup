import { describe, expect, it } from "vitest";
import type { VercelRequest } from "../../_lib/types/vercel.js";
import { providerFlowFor, providerPayerFromRequest } from "./commerceCheckoutProviderPayment.js";

describe("commerce checkout provider payment helpers", () => {
  it("maps saved Tpay recurring checkout onto the recurring charge provider flow", () => {
    expect(providerFlowFor("tpay", {
      provider: "tpay",
      flow: "blik_recurring_saved",
      savedMethodId: "22222222-2222-4222-8222-222222222222",
      recurringModel: "M",
    })).toBe("recurring_charge");

    expect(providerFlowFor("tpay", {
      provider: "tpay",
      flow: "blik_one_click",
      savedMethodId: "22222222-2222-4222-8222-222222222222",
    })).toBe("blik_one_click");
  });

  it("builds sanitized payer evidence from request headers and checkout intent contact", () => {
    expect(providerPayerFromRequest(
      {
        headers: {
          "x-forwarded-for": " 192.0.2.10, 198.51.100.10 ",
          "user-agent": ["openlupTest/1.0"],
        },
      } as unknown as VercelRequest,
      {
        contact: {
          email: "anna@example.com",
          firstName: "Anna",
          lastName: "Kowalska",
        },
      } as never,
    )).toEqual({
      email: "anna@example.com",
      name: "Anna Kowalska",
      ip: "192.0.2.10",
      userAgent: "openlupTest/1.0",
    });
  });
});
