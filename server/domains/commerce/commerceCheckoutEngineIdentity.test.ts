import { describe, expect, it } from "vitest";
import * as browser from "@openlup/platform/commerce";
import { CheckoutOrchestrationError as PackageError } from "@openlup/platform/commerce/server";
import { CheckoutOrchestrationError } from "./commerceCheckoutOrchestration.js";
import * as helpers from "./commerceCheckoutOrchestrationHelpers.js";
describe("checkout engine reference identities", () => {
  it("keeps the same neutral helper and nominal error objects at retained paths", () => {
    expect(helpers.buildOrderDeliveryContact).toBe(browser.buildOrderDeliveryContact);
    expect(helpers.uuidFromOrderRef).toBe(browser.uuidFromOrderRef);
    expect(helpers.messageOf).toBe(browser.messageOf);
    expect(CheckoutOrchestrationError).toBe(PackageError);
  });
});
