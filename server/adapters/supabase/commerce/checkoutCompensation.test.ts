import { expect, it } from "vitest";
import * as facade from "./checkoutCompensation.js";
import * as commerce from "@openlup/platform/commerce/server";

it("preserves package export identity", () => {
  expect(Object.keys(facade).sort()).toEqual([
    "cancelAbandonedCheckout",
    "cancelUnstartedPromotionCheckout",
    "createSupabaseCheckoutCompensationAdapter",
  ]);
  expect(facade.cancelAbandonedCheckout).toBe(commerce.cancelAbandonedCheckout);
  expect(facade.cancelUnstartedPromotionCheckout).toBe(commerce.cancelUnstartedPromotionCheckout);
  expect(facade.createSupabaseCheckoutCompensationAdapter).toBe(commerce.createCheckoutCompensationRpcAdapter);
});
