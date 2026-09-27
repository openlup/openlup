import { allMigrations } from "../test/effectiveMigration.js";
import { managedTable } from "../test/managedSchema.js";
import { describe, expect, it } from "vitest";

const tableNames = ["communication_provider_profiles", "communication_provider_events", "communication_sync_deliveries"];
const migration = tableNames.map(managedTable).join("\n");
// This is source evidence only. Bare-install control rows require an executable witness.
const shippedSql = allMigrations().map(({ content }) => content).join("\n");

describe("communication provider sync boundary", () => {
  it("adds provider profiles, inbound events, and per-provider deliveries", () => {
    expect(migration).toContain("CREATE TABLE public.communication_provider_profiles");
    expect(migration).toContain("CREATE TABLE public.communication_provider_events");
    expect(migration).toContain("CREATE TABLE public.communication_sync_deliveries");
    expect(migration).toContain("UNIQUE (provider_kind, provider_event_id)");
    expect(migration).toContain("UNIQUE (outbox_event_id, provider_kind)");
  });

  it("keeps sync workers disabled by default through platform job controls", () => {
    expect(shippedSql.includes("('communication-sync-dispatch', false, 'vercel_cron'")).toBe(true);
    expect(shippedSql.includes("('communication-sync-reconcile', false, 'vercel_cron'")).toBe(true);
  });

  it("keeps provider sync scoped to marketing purposes", () => {
    expect(migration).toContain("purpose = ANY (ARRAY['marketing_launch_offer'::text, 'marketing_newsletter'::text])");
    expect(migration).not.toContain("purpose = ANY (ARRAY['transactional'::text");
  });
});
