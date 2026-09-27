import { describe, expect, it } from "vitest";
import { allMigrations, effectiveFunctionBody } from "../test/effectiveMigration";
const migration = effectiveFunctionBody("commerce_pin_paid_order_reservations");
const schema = allMigrations().map(({ content }) => content).join("\n");

describe("inventory paid reservation hold boundary", () => {
  it("pins reserved stock when an order becomes paid", () => {
    for (const required of [
      "commerce_pin_paid_order_reservations",
      "NEW.status <> 'paid'",
      "UPDATE public.inventory_reservations",
      "expires_at = NULL",
      "status = 'reserved'",
      "'paid_order_hold'",
    ]) {
      expect(migration).toContain(required);
    }
    expect(schema).toMatch(/CREATE TRIGGER [^;]+AFTER INSERT OR UPDATE OF status ON public.commerce_orders[^;]+EXECUTE FUNCTION public.commerce_pin_paid_order_reservations\(\)/);
  });
});
