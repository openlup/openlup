import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { managedTable } from "../../../src/test/managedSchema.js";
const trackingSchemaMigration = managedTable("shipment_external_refs");
const orderHistoryReadStore = readFileSync(
  "server/adapters/supabase/customerOrderHistoryReadStore.ts",
  "utf8",
);

describe("customer order history schema contract", () => {
  it("backs every shipment tracking projection column with the published schema", () => {
    for (const column of ["tracking_url", "carrier_kind", "service"]) {
      expect(orderHistoryReadStore).toContain(column);
      expect(trackingSchemaMigration).toContain(`${column} text`);
    }
  });
});
