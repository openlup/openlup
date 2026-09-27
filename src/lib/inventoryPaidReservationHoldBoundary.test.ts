import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = read("supabase/migrations/20260605150000_inventory_paid_order_reservation_hold.sql");

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

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}
