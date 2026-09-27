import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = read("supabase/migrations/20260605153000_inventory_lot_invalidation_guard.sql");
const revokeMigration = read(
  "supabase/migrations/20260605160000_inventory_lot_invalidation_revoke_execute.sql",
);

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
    for (const required of [
      "REVOKE ALL ON FUNCTION public.inventory_guard_consumable_lot()",
      "REVOKE ALL ON FUNCTION public.inventory_invalidate_lot(text, uuid, text, text, jsonb)",
      "FROM PUBLIC, anon, authenticated",
      "GRANT EXECUTE ON FUNCTION public.inventory_invalidate_lot(text, uuid, text, text, jsonb)",
      "TO service_role",
    ]) {
      expect(revokeMigration).toContain(required);
    }
  });
});

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}
