import { effectiveFunctionBody } from "../test/effectiveMigration";
import { currentTrigger } from "../test/historicalBoundarySchema";
import { describe, expect, it } from "vitest";

const migration = [effectiveFunctionBody("commerce_pin_paid_order_reservations"), currentTrigger("trg_commerce_pin_paid_order_reservations")].join("\n");

describe("inventory paid reservation hold boundary", () => {
  it("pins reserved stock when an order becomes paid", () => {
    for (const required of [
      "commerce_pin_paid_order_reservations",
      "AFTER INSERT OR UPDATE OF status",
      "NEW.status <> 'paid'",
      "UPDATE public.inventory_reservations",
      "expires_at = NULL",
      "status = 'reserved'",
      "'paid_order_hold'",
    ]) {
      expect(migration).toContain(required);
    }
  });
});
