import { describe, expect, it } from "vitest";

import { operatorSubscriptionRefusalCodeSchema } from "../../../../src/domains/support/customerSupportCommandContracts.js";
import { SUBSCRIPTION_REFUSALS } from "./customerSupportCommandResponses.js";

/**
 * The contract enum and the adapter allowlist are one vocabulary written twice.
 *
 * They drifted once already, and the failure had a shape worth restating: the
 * authority answered correctly with a refusal the enum knew and the Set did not,
 * so `subscriptionCommand` threw an invalid-response error AFTER a successful
 * RPC - past the driver-error translation, into the route's generic catch, out
 * as a 503. The operator was shown an outage instead of the reason the database
 * had just given them, for the commonest support action there is.
 *
 * Until now the only thing holding the two together was a comment on each side
 * asking the next author to keep them equal. This is the same instruction,
 * addressed to CI instead of to a person.
 *
 * The assertion is deliberately two-directional. A one-directional check
 * (`every enum member is in the Set`) passes while the Set holds a code no
 * contract admits, which is the other half of the same drift: the adapter would
 * report a refusal the response schema then rejects at the route boundary, and
 * the operator sees the identical anonymous failure from the opposite cause.
 */
describe("the operator refusal vocabulary is written twice and must stay one vocabulary", () => {
  const enumCodes = [...operatorSubscriptionRefusalCodeSchema.options].sort();
  const adapterCodes = [...SUBSCRIPTION_REFUSALS].sort();

  it("admits every code the contract declares, so a stated reason is never a 503", () => {
    expect(adapterCodes).toEqual(enumCodes);
  });

  it("declares every code the adapter admits, so the reverse drift fails too", () => {
    expect(enumCodes).toEqual(adapterCodes);
  });

  // A set-equality assertion between two empty collections is vacuously true, and a
  // refactor that emptied either side would pass both cases above. This is the floor.
  it("is a non-empty vocabulary, so the equality above cannot be vacuous", () => {
    expect(enumCodes.length).toBeGreaterThan(0);
    expect(new Set(enumCodes).size).toBe(enumCodes.length);
  });

  // The verb this wave added is the reason the vocabulary moved at all; pinning the
  // member by name makes a silent removal a failure rather than a smaller green set.
  it("carries the address refusal the change_shipping_address verb can answer with", () => {
    expect(enumCodes).toContain("invalid_address");
    expect(SUBSCRIPTION_REFUSALS.has("invalid_address")).toBe(true);
  });
});
