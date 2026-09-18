import { describe, expect, it } from "vitest";
import { platformOwnsBuyerEmail } from "./orderCommsPolicy.js";

describe("platformOwnsBuyerEmail", () => {
  it("keeps platform ownership when no channel policy exists (storefront/legacy)", () => {
    expect(platformOwnsBuyerEmail(null)).toBe(true);
  });

  it("keeps platform ownership when the channel declares platform comms", () => {
    expect(
      platformOwnsBuyerEmail({ sourceKind: "marketplace", buyerCommsOwner: "platform" }),
    ).toBe(true);
  });

  it("yields ownership when the channel owns buyer comms", () => {
    expect(
      platformOwnsBuyerEmail({ sourceKind: "marketplace", buyerCommsOwner: "channel" }),
    ).toBe(false);
  });
});
