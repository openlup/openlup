import { describe, expect, it } from "vitest";
import {
  dispatchIdempotencyKey,
  isOmnipackDispatchContactStale,
  OMNIPACK_DISPATCH_CONTACT_STALE,
  readOmnipackDispatchBatchLimit,
  readOmnipackDispatchMode,
} from "./omnipackDispatchContracts.js";

describe("OmniPack dispatch contracts", () => {
  it("keeps dispatch mode and batch limit fail-closed", () => {
    expect(readOmnipackDispatchMode({})).toBe("shadow");
    expect(readOmnipackDispatchMode({ COMMERCE_OMNIPACK_DISPATCH_MODE: "stage" })).toBe("stage");
    expect(readOmnipackDispatchMode({ COMMERCE_OMNIPACK_DISPATCH_MODE: "production" })).toBe("shadow");
    expect(readOmnipackDispatchBatchLimit({ COMMERCE_OMNIPACK_DISPATCH_BATCH_LIMIT: "1" })).toBe(1);
    expect(readOmnipackDispatchBatchLimit({ COMMERCE_OMNIPACK_DISPATCH_BATCH_LIMIT: "101" })).toBe(25);
  });

  it("uses fulfillment-order scoped idempotency keys", () => {
    expect(dispatchIdempotencyKey("fulfillment-1")).toBe("omnipack-dispatch:fulfillment-1");
  });

  it("recognizes only the named pre-effect stale-contact refusal", () => {
    expect(isOmnipackDispatchContactStale(new Error(OMNIPACK_DISPATCH_CONTACT_STALE))).toBe(true);
    expect(isOmnipackDispatchContactStale(new Error("omnipack_dispatch_ref_write_failed:40001"))).toBe(false);
    expect(isOmnipackDispatchContactStale("omnipack_dispatch_contact_stale")).toBe(false);
  });
});
