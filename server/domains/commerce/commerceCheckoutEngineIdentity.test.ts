import { describe, expect, it } from "vitest";
import * as browser from "@openlup/platform/commerce";
import { CheckoutOrchestrationError as PackageError } from "@openlup/platform/commerce/server";
import * as journey from "./commerceCheckoutJourney.js";
import { CheckoutOrchestrationError, messageOf } from "./commerceCheckoutOrchestrationError.js";
import * as helpers from "./commerceCheckoutOrchestrationHelpers.js";
describe("checkout engine reference identities", () => {
  it("keeps the same neutral helper and nominal error objects at retained paths", () => {
    expect(journey.buildOrderDeliveryContact).toBe(browser.buildOrderDeliveryContact);
    expect(journey.uuidFromOrderRef).toBe(browser.uuidFromOrderRef);
    expect(helpers.buildOrderDeliveryContact).toBe(journey.buildOrderDeliveryContact);
    expect(helpers.messageOf).toBe(messageOf); expect(messageOf).toBe(browser.messageOf);
    expect(CheckoutOrchestrationError).toBe(PackageError);
  });
});
