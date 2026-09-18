import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILE = "db/platform/migrations/20260814000000_fulfillment_stock_evidence.sql";
const sql = readFileSync(FILE, "utf8");
const executable = sql.replace(/^\s*--.*$/gm, "");

describe("fulfillment stock evidence public forward", () => {
  it("owns only observation, snapshot, cursor and discrepancy evidence", () => {
    for (const name of ["fulfillment_stock_sync_cursors", "fulfillment_stock_current",
      "fulfillment_stock_operations",
      "fulfillment_stock_snapshots", "fulfillment_stock_evidence"]) expect(sql).toContain(name);
    expect(sql).toContain("fulfillment_record_stock_current");
    expect(sql).toContain("fulfillment_resolve_stock_evidence");
  });
  it("does not copy provider payload, identity, reservation or status schemas", () => {
    expect(executable).not.toMatch(/omnipack|testers|clients|inventory_reservations|provider_payload|SECURITY\s+DEFINER/i);
    expect(executable).not.toMatch(/^\s*GRANT\s+/im);
  });
});
