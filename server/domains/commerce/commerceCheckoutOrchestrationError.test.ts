import { expect, it } from "vitest";
import * as facade from "./commerceCheckoutOrchestrationError.js";
import * as commerce from "@openlup/platform/commerce";
import * as commerceServer from "@openlup/platform/commerce/server";

it("preserves package export identity", () => {
  expect(Object.keys(facade).sort()).toEqual(["CheckoutOrchestrationError", "messageOf"]);
  expect(facade.CheckoutOrchestrationError).toBe(commerceServer.CheckoutOrchestrationError);
  expect(facade.messageOf).toBe(commerce.messageOf);
});
