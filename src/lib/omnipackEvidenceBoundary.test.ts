import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allMigrations } from "../test/effectiveMigration.js";
import { managedFunction, managedTable } from "../test/managedSchema.js";

const migration = [...["omnipack_dispatch_refs", "omnipack_status_evidence", "omnipack_stock_sync_cursors", "omnipack_stock_snapshots", "omnipack_low_stock_evidence"].map(managedTable), ...["omnipack_record_dispatch_ref", "omnipack_record_status_evidence", "omnipack_upsert_stock_sync_cursor", "omnipack_record_stock_snapshot", "omnipack_record_low_stock_evidence"].map(managedFunction)].join("\n");
const stockAuthorityMigration = [managedTable("fulfillment_provider_stock_current"), managedFunction("commerce_fulfillment_mark_provider_stock_consumed"), managedFunction("inventory_consume_reservation_for_fulfillment"), managedFunction("inventory_reserve_order")].join("\n");

describe("OmniPack evidence model boundary", () => {
  it("creates durable provider evidence tables and service-role RPCs only", () => {
    for (const table of [
      "omnipack_dispatch_refs",
      "omnipack_status_evidence",
      "omnipack_stock_sync_cursors",
      "omnipack_stock_snapshots",
      "omnipack_low_stock_evidence",
    ]) {
      expect(migration).toContain(`CREATE TABLE public.${table}`);
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`REVOKE ALL ON TABLE public.${table} FROM anon, authenticated`);
      expect(migration).toContain(`GRANT SELECT, INSERT, UPDATE ON TABLE public.${table} TO service_role`);
    }

    for (const fn of [
      "omnipack_record_dispatch_ref",
      "omnipack_record_status_evidence",
      "omnipack_upsert_stock_sync_cursor",
      "omnipack_record_stock_snapshot",
      "omnipack_record_low_stock_evidence",
    ]) {
      expect(migration).toContain(`CREATE FUNCTION public.${fn}`);
      expect(migration).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([\\s\\S]*?\\) TO service_role;`));
      expect(migration).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([\\s\\S]*?\\) FROM PUBLIC, anon, authenticated;`));
    }
  });

  it("seeds OmniPack as a fulfillment provider and does not activate provider traffic", () => {
    expect(migration.includes("VALUES ('omnipack', 'fulfillment', 'OmniPack Fulfillment', 'experimental')")).toBe(true);
    expect(migration).not.toContain("api.stage.omnipack.tech");
    expect(migration).not.toContain("api.omnipack.tech");
    expect(migration).not.toContain("Authorization: Basic");
  });

  it("keeps tracking and webhook idempotency in the existing shared stores", () => {
    expect(migration).toContain("REFERENCES public.inbound_provider_events(id) ON DELETE SET NULL");
    // The dump drops historical comments; durable linkage and absence of a
    // tracking fork are the structural obligation they described.
    expect(migration).toContain("inbound_provider_event_id");
    const schema = allMigrations().map(({ content }) => content).join("\n");
    expect(schema).not.toMatch(/^CREATE TABLE (?:IF NOT EXISTS )?public\.omnipack_tracking\b/im);
    expect(migration).not.toMatch(/INSERT INTO public\.shipment_external_refs/i);
  });

  it("keeps the original OmniPack evidence slice free from local inventory mutations", () => {
    // Assert the declared comparison fields and mutation refusal directly,
    // rather than historical migration comments absent from the dump.
    expect(managedTable("omnipack_stock_snapshots")).toContain("local_on_hand integer");
    expect(managedTable("omnipack_stock_snapshots")).toContain("local_reserved integer");
    expect(migration).not.toMatch(/\bINSERT INTO public\.inventory_/i);
    expect(migration).not.toMatch(/\bUPDATE public\.inventory_/i);
    expect(migration).not.toContain("inventory_consume_reservation");
    expect(migration).not.toContain("inventory_adjust_stock");
    expect(migration).not.toContain("inventory_reserve_order");
  });

  it("adds the external stock-master overlay only in the explicit stock-authority migration", () => {
    expect(stockAuthorityMigration).toContain("CREATE TABLE public.fulfillment_provider_stock_current");
    expect(stockAuthorityMigration).toContain("external_stock_master_with_local_reservations");
    expect(stockAuthorityMigration).toContain("commerce_fulfillment_mark_provider_stock_consumed");
    expect(stockAuthorityMigration).toContain("inventory_consume_reservation_for_fulfillment");
  });

  it("has a rollback-only probe covering replay, no tracking fork, and no inventory consumption", () => {
    const probe = read("docs/sql/omnipack_fulfillment_evidence_probe.sql");
    expect(probe).toContain("BEGIN;");
    expect(probe).toContain("ROLLBACK;");
    expect(probe).toContain("omnipack_record_dispatch_ref");
    expect(probe).toContain("omnipack_record_status_evidence");
    expect(probe).toContain("omnipack_upsert_stock_sync_cursor");
    expect(probe).toContain("omnipack_record_stock_snapshot");
    expect(probe).toContain("omnipack_record_low_stock_evidence");
    expect(probe).toContain("v_dispatch_replay->>'replayed' <> 'true'");
    expect(probe).toContain("v_status_replay->>'replayed' <> 'true'");
    expect(probe).toContain("v_snapshot_replay->>'replayed' <> 'true'");
    expect(probe).toContain("v_low_stock_replay->>'replayed' <> 'true'");
    expect(probe).toContain("shipment_external_refs");
    expect(probe).toContain("inventory_stock_movements");
  });

  it("documents the evidence model and lists the rehearsal probe", () => {
    const omnipackDocs = read("docs/platform/FULFILLMENT_ADAPTER.md");
    const docsIndex = read("docs/platform/README.md");
    expect(omnipackDocs).toContain("## Local Evidence Model");
    expect(omnipackDocs).toContain("omnipack_dispatch_refs");
    expect(omnipackDocs).toContain("omnipack_stock_snapshots");
    expect(omnipackDocs).toContain("omnipack_low_stock_evidence");
    expect(docsIndex).toContain("FULFILLMENT_ADAPTER.md");
    expect(omnipackDocs).toContain("missing rollback-only database replay/stock/nonmutation probe");
    expect(omnipackDocs).toContain("plans/public-ci-known-red.md");
  });
});

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}
