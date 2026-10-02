import { effectiveFunctionBody } from "../test/effectiveMigration";
import { describe, expect, it } from "vitest";

const migration = effectiveFunctionBody("commerce_fulfillment_cancel_order");
const hardeningMigration = migration;

describe("fulfillment cancel release boundary", () => {
  it("releases inventory reservations when pre-handoff fulfillment is cancelled", () => {
    expect(migration).toContain("commerce_fulfillment_cancel_order");
    expect(migration).toContain("inventory_reservation_ids");
    expect(migration).toContain("inventory_release_reservation");
    expect(migration).toContain("fulfillment_cancelled");
    expect(migration).toContain("releasedReservationIds");
  });

  it("keeps after-handoff cancellation forbidden", () => {
    const permitted = migration.match(/IF v_fulfillment\.status NOT IN \(([^)]+)\) THEN\s*RAISE EXCEPTION 'commerce_fulfillment_cancel_after_label_forbidden'/)?.[1];
    expect(permitted).toBeDefined();
    const statuses = permitted?.match(/'([^']+)'/g)?.map((status) => status.slice(1, -1));
    expect(statuses).toEqual(["created", "packed", "label_pending"]);
    expect(statuses).not.toContain("handed_over");
    expect(statuses).not.toContain("delivered");
  });

  it("tightens preview cancel to local pre-label statuses only", () => {
    expect(hardeningMigration).toContain("v_fulfillment.status NOT IN ('created', 'packed', 'label_pending')");
    expect(hardeningMigration).toContain("commerce_fulfillment_cancel_after_label_forbidden");
    expect(hardeningMigration).toContain("commerce_fulfillment_cancel_idempotency_conflict");
  });
});
