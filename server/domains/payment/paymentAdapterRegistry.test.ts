import { describe, expect, it } from "vitest";
import * as runtime from "../../runtime/payment/paymentAdapterRegistry.js";
import * as deprecated from "./paymentAdapterRegistry.js";

// The registry's behaviour is tested beside it in server/runtime/payment. This
// file pins only the deprecated re-export, and goes with it in
// openlup-source-preview/9.
const LEGACY_NAMES = [
  "getPaymentExecutionAdapter",
  "NoopSettlementNotAllowedError",
  "UnknownPaymentProviderError",
] as const;

describe("deprecated server/domains/payment/paymentAdapterRegistry", () => {
  it("re-exports exactly the three legacy bindings of the runtime registry", () => {
    expect(Object.keys(deprecated).sort()).toEqual([...LEGACY_NAMES].sort());
    for (const name of LEGACY_NAMES) {
      expect(deprecated[name]).toBe(runtime[name]);
    }
  });
});
