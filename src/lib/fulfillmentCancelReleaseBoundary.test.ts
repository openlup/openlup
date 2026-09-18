import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260605155000_fulfillment_cancel_release_reservations.sql",
  "utf8",
);
const hardeningMigration = readFileSync(
  "supabase/migrations/20260613221000_admin_oms_preview_hardening.sql",
  "utf8",
);

describe("fulfillment cancel release boundary", () => {
  it("releases inventory reservations when pre-handoff fulfillment is cancelled", () => {
    expect(migration).toContain("commerce_fulfillment_cancel_order");
    expect(migration).toContain("inventory_reservation_ids");
    expect(migration).toContain("inventory_release_reservation");
    expect(migration).toContain("fulfillment_cancelled");
    expect(migration).toContain("releasedReservationIds");
  });

  it("keeps after-handoff cancellation forbidden", () => {
    expect(migration).toContain("handed_over");
    expect(migration).toContain("commerce_fulfillment_cancel_after_handoff_forbidden");
  });

  it("tightens preview cancel to local pre-label statuses only", () => {
    expect(hardeningMigration).toContain("v_fulfillment.status NOT IN ('created', 'packed', 'label_pending')");
    expect(hardeningMigration).toContain("commerce_fulfillment_cancel_after_label_forbidden");
    expect(hardeningMigration).toContain("commerce_fulfillment_cancel_idempotency_conflict");
  });
});
