import { describe, expect, it } from "vitest";
import {
  omnipackDispatchAcceptanceKeys,
  parseOmnipackDispatchAcceptanceResult,
} from "./omnipackDispatchAcceptance.js";

const ACCEPTED = {
  dispatchRefId: "ref-1",
  fulfillmentOrderId: "ful-1",
  orderId: "order-1",
  providerOrderId: "provider-order-1",
  dispatchStatus: "created",
  fulfillmentStatus: "label_created",
  replayed: false,
};

describe("OmniPack dispatch acceptance contract", () => {
  it("keeps provider acceptance and label acknowledgement on separate stable keys", () => {
    expect(omnipackDispatchAcceptanceKeys("ful-1")).toEqual({
      providerAttemptIdempotencyKey: "omnipack-dispatch:ful-1:provider-accepted",
      labelIdempotencyKey: "omnipack-dispatch:ful-1:label-ack",
    });
  });

  it.each([null, "", "   "])("rejects created read-back without a provider order id (%j)", (providerOrderId) => {
    expect(() => parseOmnipackDispatchAcceptanceResult(
      { ...ACCEPTED, providerOrderId },
      "invalid_acceptance_readback",
    )).toThrow("invalid_acceptance_readback");
  });

  it("returns a normalized, nonblank provider order id", () => {
    expect(parseOmnipackDispatchAcceptanceResult(
      { ...ACCEPTED, providerOrderId: "  provider-order-1  " },
      "invalid_acceptance_readback",
    )).toMatchObject({ providerOrderId: "provider-order-1", fulfillmentStatus: "label_created" });
  });
});
