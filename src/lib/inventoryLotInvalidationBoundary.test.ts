import { describe, expect, it } from "vitest";
import { managedFunction } from "../test/managedSchema";
const functions = ["inventory_guard_consumable_lot", "inventory_invalidate_lot"];
const migration = functions.map(managedFunction).join("\n");

describe("inventory lot invalidation boundary", () => {
  it("releases active reservations for recalled/expired lots and blocks stale consumption", () => {
    for (const required of [
      "inventory_guard_consumable_lot",
      "inventory_lot_not_consumable",
      "inventory_invalidate_lot",
      "p_next_status NOT IN ('expired', 'recalled', 'quarantined')",
      "status = 'released'",
      "reservation_released",
      "releasedReservationCount",
    ]) {
      expect(migration).toContain(required);
    }
  });

  it("keeps lot invalidation functions service-role-only", () => {
    for (const fn of functions) {
      const sql = managedFunction(fn);
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}[^;]+FROM PUBLIC;`));
      expect(sql).not.toMatch(/GRANT [^;]+TO (?:PUBLIC|anon|authenticated)/);
    }
    expect(managedFunction("inventory_invalidate_lot")).toMatch(/GRANT ALL ON FUNCTION public\.inventory_invalidate_lot[^;]+TO service_role;/);
  });
});
