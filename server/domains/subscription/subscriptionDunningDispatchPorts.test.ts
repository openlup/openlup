import { describe, expect, it } from "vitest";

import {
  DUNNING_PAYMENT_EXPIRED_TEMPLATE_SLUG,
  DUNNING_PAYMENT_FAILED_TEMPLATE_PREFIX,
} from "./subscriptionDunningDispatchPorts.js";
import {
  type DunningEmailSendOutcome,
} from "./dunningDeliveryOutcome.js";

describe("subscription dunning dispatch ports", () => {
  it("keeps canonical template slug constants stable", () => {
    expect(DUNNING_PAYMENT_FAILED_TEMPLATE_PREFIX).toBe("subscription-payment-failed");
    expect(DUNNING_PAYMENT_EXPIRED_TEMPLATE_SLUG).toBe("subscription-payment-expired");
  });

  it("models admin-disabled sends as terminal transport outcomes", () => {
    const outcome: DunningEmailSendOutcome = {
      ok: true,
      deliveryId: null,
      httpStatus: 0,
      aborted: false,
      adminDisabled: true,
    };

    expect(outcome).toMatchObject({ ok: true, adminDisabled: true, deliveryId: null });
  });
});
