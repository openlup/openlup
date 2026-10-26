import { expect, expectTypeOf, it } from "vitest";
import { tryCompensate as packageTryCompensate, type CheckoutCompensationPort as PackagePort } from "@openlup/platform/commerce/server";
import { tryCompensate, type CheckoutCompensationPort } from "./commerceCheckoutCompensation.js";

it("delegates checkout compensation to the package with identical function and port identity", () => {
  expect(tryCompensate).toBe(packageTryCompensate);
  expectTypeOf<CheckoutCompensationPort>().toEqualTypeOf<PackagePort>();
});
