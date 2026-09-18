import { describe, expect, it } from "vitest";
import { subscriptionIdsFrom } from "./customerJourneyLookup.js";

describe("customer journey lookup helpers", () => {
  it("deduplicates subscription ids from lookup and linked orders", () => {
    expect(subscriptionIdsFrom(
      { subscriptionId: "sub-1" } as never,
      [{ subscription_id: "sub-1" }, { subscription_id: "sub-2" }],
    )).toEqual(["sub-1", "sub-2"]);
  });
});
