import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = read("supabase/migrations/20260610123000_omnipack_fulfillment_evidence.sql");
const stockAuthorityMigration = read("supabase/migrations/20260710130000_fulfillment_provider_stock_authority.sql");
const probe = read("docs/sql/omnipack_fulfillment_evidence_probe.sql");
const omnipackDocs = read("docs/COMMERCE_OMNIPACK_INTEGRATION.md");
const docsIndex = read("docs/README.md");

describe("OmniPack evidence model boundary", () => {
  it("creates durable provider evidence tables and service-role RPCs only", () => {
    for (const table of [
      "omnipack_dispatch_refs",
      "omnipack_status_evidence",
      "omnipack_stock_sync_cursors",
      "omnipack_stock_snapshots",
      "omnipack_low_stock_evidence",
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
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
      expect(migration).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
      expect(migration).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([\\s\\S]*?\\) TO service_role;`));
      expect(migration).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([\\s\\S]*?\\) FROM PUBLIC, anon, authenticated;`));
    }
  });

  it("seeds OmniPack as a fulfillment provider and does not activate provider traffic", () => {
    expect(migration).toContain("VALUES ('omnipack', 'fulfillment', 'OmniPack Fulfillment', 'experimental')");
    expect(migration).not.toContain("api.stage.omnipack.tech");
    expect(migration).not.toContain("api.omnipack.tech");
    expect(migration).not.toContain("Authorization: Basic");
  });

  it("keeps tracking and webhook idempotency in the existing shared stores", () => {
    expect(migration).toContain("REFERENCES public.inbound_provider_events(id) ON DELETE SET NULL");
    expect(migration).toContain("Tracking numbers remain in shipment_external_refs");
    expect(migration).toContain("webhook idempotency");
    expect(migration).not.toMatch(/CREATE TABLE IF NOT EXISTS public\.omnipack_tracking/i);
    expect(migration).not.toMatch(/INSERT INTO public\.shipment_external_refs/i);
  });

  it("keeps the original OmniPack evidence slice free from local inventory mutations", () => {
    expect(migration).toContain("Provider stock evidence compared with local inventory");
    expect(migration).toContain("Local inventory remains source of truth");
    expect(migration).not.toMatch(/\bINSERT INTO public\.inventory_/i);
    expect(migration).not.toMatch(/\bUPDATE public\.inventory_/i);
    expect(migration).not.toContain("inventory_consume_reservation");
    expect(migration).not.toContain("inventory_adjust_stock");
    expect(migration).not.toContain("inventory_reserve_order");
  });

  it("adds the external stock-master overlay only in the explicit stock-authority migration", () => {
    expect(stockAuthorityMigration).toContain("CREATE TABLE IF NOT EXISTS public.fulfillment_provider_stock_current");
    expect(stockAuthorityMigration).toContain("external_stock_master_with_local_reservations");
    expect(stockAuthorityMigration).toContain("commerce_fulfillment_mark_provider_stock_consumed");
    expect(stockAuthorityMigration).toContain("inventory_consume_reservation_for_fulfillment");
  });

  it("has a rollback-only probe covering replay, no tracking fork, and no inventory consumption", () => {
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
    expect(omnipackDocs).toContain("## Local Evidence Model");
    expect(omnipackDocs).toContain("omnipack_dispatch_refs");
    expect(omnipackDocs).toContain("omnipack_stock_snapshots");
    expect(omnipackDocs).toContain("omnipack_low_stock_evidence");
    expect(docsIndex).toContain("sql/omnipack_fulfillment_evidence_probe.sql");
  });
});

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}
