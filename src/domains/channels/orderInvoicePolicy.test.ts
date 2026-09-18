import { describe, expect, it } from "vitest";
import {
  platformIssuesInvoice,
  resolveOrderInvoiceAction,
} from "./orderInvoicePolicy.js";

describe("orderInvoicePolicy", () => {
  it("issues for an order that names no channel", () => {
    expect(resolveOrderInvoiceAction(null)).toBe("issue");
    expect(platformIssuesInvoice(null)).toBe(true);
  });

  it("returns each declared policy verbatim", () => {
    for (const invoicePolicy of ["issue", "suppress", "channel_issues"]) {
      expect(resolveOrderInvoiceAction({ sourceKind: "marketplace", invoicePolicy }))
        .toBe(invoicePolicy);
    }
  });

  it("fails OPEN to issue on a value this build does not know", () => {
    // A sales document is a legal artifact: an unrecognised stored value must
    // not silently stop this deployment issuing one. The DB CHECK constraint is
    // what keeps this branch unreachable in practice.
    expect(resolveOrderInvoiceAction({ sourceKind: "marketplace", invoicePolicy: "later_maybe" }))
      .toBe("issue");
    expect(platformIssuesInvoice({ sourceKind: "marketplace", invoicePolicy: "" }))
      .toBe(true);
  });

  it("ignores sourceKind entirely — the policy is the channel's, not the axis's", () => {
    expect(resolveOrderInvoiceAction({ sourceKind: "storefront", invoicePolicy: "suppress" }))
      .toBe("suppress");
    expect(platformIssuesInvoice({ sourceKind: "marketplace", invoicePolicy: "issue" }))
      .toBe(true);
  });
});
