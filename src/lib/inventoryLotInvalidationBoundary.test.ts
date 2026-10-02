import { effectiveFunctionBody } from "../test/effectiveMigration";
import { explicitFunctionExecuteRoles } from "../test/historicalBoundarySchema";
import { describe, expect, it } from "vitest";

const migration = [effectiveFunctionBody("inventory_guard_consumable_lot"), effectiveFunctionBody("inventory_invalidate_lot")].join("\n");

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
    for (const name of ["inventory_guard_consumable_lot", "inventory_invalidate_lot"]) {
      const overloads = explicitFunctionExecuteRoles(name);
      for (const roles of overloads.values()) {
        expect(roles.has("service_role")).toBe(true);
        for (const browser of ["PUBLIC", "anon", "authenticated"]) expect(roles.has(browser)).toBe(false);
      }
    }
  });
});
