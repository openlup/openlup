import { describe, expect, it } from "vitest";
import {
  matchCanonicalMoneyLegacyException,
  type CanonicalMoneyLegacyException,
} from "./orderMoneyLegacyExceptions.js";
import type { OrderMoneyReconciliationEvidence } from "./orderMoneyReconciliationContracts.js";

describe("canonical order money legacy exceptions", () => {
  it("matches an adopter registry exactly and fails closed on empty or drifted evidence", () => {
    const evidence = auditedEvidence();
    expect(matchCanonicalMoneyLegacyException(evidence, [SYNTHETIC_EXCEPTION])?.reason)
      .toBe("pre_canonical_corrected_reissue");
    expect(matchCanonicalMoneyLegacyException(evidence, [])).toBeNull();

    for (const drift of [
      { ...evidence, order: { ...evidence.order, amountCents: 11_176 } },
      { ...evidence, order: { ...evidence.order, currency: "EUR" } },
      { ...evidence, mismatchCodes: ["invoice_net_amount"] as OrderMoneyReconciliationEvidence["mismatchCodes"] },
      { ...evidence, invoiceLineageIds: { ...evidence.invoiceLineageIds, currentInvoiceId: evidence.invoiceLineageIds.rootInvoiceIds[0] } },
    ]) {
      expect(matchCanonicalMoneyLegacyException(drift, [SYNTHETIC_EXCEPTION])).toBeNull();
    }
  });
});

function auditedEvidence(): Pick<OrderMoneyReconciliationEvidence,
  "orderId" | "order" | "mismatchCodes" | "invoiceLineageIds"> {
  return {
    orderId: SYNTHETIC_EXCEPTION.orderId,
    order: {
      id: SYNTHETIC_EXCEPTION.orderId,
      amountCents: 11_175,
      currency: SYNTHETIC_EXCEPTION.currency,
      subtotalCents: 11_175,
      discountCents: 0,
      shippingCents: 0,
      shippingDiscountCents: 0,
      taxCents: 828,
      netCents: 10_347,
    },
    mismatchCodes: ["invoice_net_amount", "invoice_positions_invalid"],
    invoiceLineageIds: {
      rootInvoiceIds: [SYNTHETIC_EXCEPTION.rootInvoiceId],
      invoiceIds: [
        SYNTHETIC_EXCEPTION.rootInvoiceId,
        SYNTHETIC_EXCEPTION.replacementInvoiceId,
      ],
      documentKeys: [],
      currentInvoiceId: SYNTHETIC_EXCEPTION.replacementInvoiceId,
    },
  };
}

const SYNTHETIC_EXCEPTION: CanonicalMoneyLegacyException = {
  orderId: "11111111-1111-4111-8111-111111111111",
  rootInvoiceId: "22222222-2222-4222-8222-222222222222",
  replacementInvoiceId: "33333333-3333-4333-8333-333333333333",
  grossCents: 11_175,
  currency: "ZZZ",
  mismatchCodes: ["invoice_net_amount", "invoice_positions_invalid"],
  reason: "pre_canonical_corrected_reissue",
};
