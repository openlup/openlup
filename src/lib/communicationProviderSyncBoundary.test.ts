import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260613231000_communications_provider_sync_foundation.sql",
  "utf8",
);

describe("communication provider sync boundary", () => {
  it("adds provider profiles, inbound events, and per-provider deliveries", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.communication_provider_profiles");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.communication_provider_events");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.communication_sync_deliveries");
    expect(migration).toContain("UNIQUE (provider_kind, provider_event_id)");
    expect(migration).toContain("UNIQUE (outbox_event_id, provider_kind)");
  });

  it("keeps sync workers disabled by default through platform job controls", () => {
    expect(migration).toContain("('communication-sync-dispatch', false, 'vercel_cron'");
    expect(migration).toContain("('communication-sync-reconcile', false, 'vercel_cron'");
  });

  it("keeps provider sync scoped to marketing purposes", () => {
    expect(migration).toContain("purpose text NOT NULL CHECK (purpose IN ('marketing_launch_offer', 'marketing_newsletter'))");
    expect(migration).not.toContain("purpose text NOT NULL CHECK (purpose IN ('transactional'");
  });
});
