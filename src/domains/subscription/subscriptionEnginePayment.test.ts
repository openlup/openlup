import { describe, expect, it } from "vitest";
import {
  recordPaymentFailure as appRecordPaymentFailure,
  recordPaymentSuccess as appRecordPaymentSuccess,
} from "./subscriptionEngine.js";
import {
  recordPaymentFailure as coreRecordPaymentFailure,
  recordPaymentSuccess as coreRecordPaymentSuccess,
} from "@openlup/core/subscription";

describe("subscription payment app shim", () => {
  it("re-exports package-owned payment mutations", () => {
    expect(appRecordPaymentFailure).toBe(coreRecordPaymentFailure);
    expect(appRecordPaymentSuccess).toBe(coreRecordPaymentSuccess);
  });
});
