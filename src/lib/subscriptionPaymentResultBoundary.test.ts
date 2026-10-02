import { describe, expect, it } from "vitest";
import { effectiveFunctionBody } from "../test/effectiveMigration";
import { explicitFunctionExecuteRoles, currentTrigger } from "../test/historicalBoundarySchema";

describe("current subscription payment result boundary", () => {
  for (const name of ["subscription_apply_payment_success", "subscription_apply_payment_failure"]) {
    it(`${name} refuses before any durable payment or lifecycle write`, () => {
      const body = effectiveFunctionBody(name);
      expect(body).toContain("RAISE EXCEPTION 'subscription_payment_result_deprecated_use_payment_control'");
      expect(body).not.toMatch(/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+public\.(?:commerce_orders|commerce_payments|subscription_cycles|subscriptions)/);
      for (const roles of explicitFunctionExecuteRoles(name).values()) {
        expect(roles.has("service_role")).toBe(true);
        for (const role of ["PUBLIC", "anon", "authenticated"]) expect(roles.has(role)).toBe(false);
      }
    });
  }
  it("retains the installed paid-order shipment guard", () => {
    expect(currentTrigger("trg_commerce_guard_paid_order_shipment_ref")).toContain("commerce_guard_paid_order_shipment_ref()");
    const body = effectiveFunctionBody("commerce_guard_paid_order_shipment_ref");
    expect(body).toContain("paid");
    expect(body).toMatch(/RAISE EXCEPTION/);
  });
});
