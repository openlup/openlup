import { describe, expect, it } from "vitest";
import {
  isOmnipackReconciliationManualReviewError,
  omnipackReconciliationWriteError,
} from "./omnipackReconciliationError.js";

describe("OmniPack reconciliation errors", () => {
  it("allows only whitelisted state conflicts into manual review", () => {
    const stateConflict = omnipackReconciliationWriteError("provider_stock_consumed", {
      code: "22023",
      message: "commerce_fulfillment_provider_stock_consumed_requires_label",
    });
    const invalidInput = omnipackReconciliationWriteError("provider_stock_consumed", {
      code: "22023",
      message: "commerce_fulfillment_provider_stock_consumed_invalid_input",
    });
    const unknown = omnipackReconciliationWriteError("provider_stock_consumed", {
      code: "XX000",
      message: "raw provider payload must not propagate",
    });

    expect(isOmnipackReconciliationManualReviewError(stateConflict)).toBe(true);
    expect(isOmnipackReconciliationManualReviewError(invalidInput)).toBe(false);
    expect(isOmnipackReconciliationManualReviewError(unknown)).toBe(false);
    expect(unknown.message).not.toContain("raw provider payload");
  });
});
