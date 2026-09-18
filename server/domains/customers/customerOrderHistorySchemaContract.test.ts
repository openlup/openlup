import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const trackingSchemaMigration = readFileSync(
  "supabase/migrations/20260630180001_customer_tracking_refs_schema_drift.sql",
  "utf8",
);
const orderHistoryReadStore = readFileSync(
  "server/adapters/supabase/customerOrderHistoryReadStore.ts",
  "utf8",
);

describe("customer order history schema contract", () => {
  it("keeps shipment tracking projection columns backed by an additive migration", () => {
    for (const column of ["tracking_url", "carrier_kind", "service"]) {
      expect(orderHistoryReadStore).toContain(column);
      expect(trackingSchemaMigration).toContain(`ADD COLUMN IF NOT EXISTS ${column} text`);
    }
  });
});
