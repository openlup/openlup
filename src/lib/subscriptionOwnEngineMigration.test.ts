import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { allMigrations } from "../test/effectiveMigration.js";
import { managedTable } from "../test/managedSchema.js";

const current = ["subscriptions", "subscription_cycles", "commerce_orders", "subscription_events"]
  .map(managedTable).concat(allMigrations().flatMap(({ content }) =>
    [...content.matchAll(/^CREATE UNIQUE INDEX subscription_(?:cycles|events)_[^;]+;/gm)].map(([statement]) => statement),
  )).join("\n");
function historicalMigration() {
  return readFileSync(join(process.cwd(), "supabase/migrations/20260604172000_commerce_v2_w7c_subscription_own_engine.sql"), "utf8");
}

describe("subscription own-engine migration", () => {
  it("has a zero-row guard before dropping provider-owned subscription structures", () => {
    const current = historicalMigration();
    expect(current).toMatch(/count\(\*\)[\s\S]+subscriptions has rows/);
    expect(current).toMatch(/count\(\*\)[\s\S]+subscription_cycles has rows/);
    expect(current).toMatch(/DROP TABLE IF EXISTS public\.subscription_external_refs/);
  });

  it("removes provider cycle ownership from cycles and commerce orders", () => {
    const current = historicalMigration();
    expect(current).toContain("DROP COLUMN IF EXISTS provider_cycle_id");
    expect(current).toContain("DROP COLUMN IF EXISTS provider_kind");
    expect(current).toContain("DROP COLUMN IF EXISTS provider_charge_id");
    expect(current).toContain("ADD COLUMN IF NOT EXISTS subscription_cycle_id uuid");
  });

  it("adds engine-owned snapshots, retry fields, and idempotency", () => {
    expect(current).toContain("template_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL");
    expect(current).toContain("pricing_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL");
    expect(current).toContain("retry_attempt integer DEFAULT 0 NOT NULL");
    expect(current).toContain("engine_idempotency_key text NOT NULL");
    expect(current).toContain("subscription_cycles_engine_idempotency_key_key");
  });

  it("creates admin-only audit events with unique idempotency", () => {
    expect(current).toContain("CREATE TABLE public.subscription_events");
    expect(current).toContain("ALTER TABLE public.subscription_events ENABLE ROW LEVEL SECURITY");
    expect(current).toContain("CREATE POLICY admin_all_subscription_events");
    expect(current).toContain("subscription_events_idempotency_key_key");
  });
});
