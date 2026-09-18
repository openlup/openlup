import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260604172000_commerce_v2_w7c_subscription_own_engine.sql",
  ),
  "utf8",
);

describe("subscription own-engine migration", () => {
  it("has a zero-row guard before dropping provider-owned subscription structures", () => {
    expect(sql).toMatch(/count\(\*\)[\s\S]+subscriptions has rows/);
    expect(sql).toMatch(/count\(\*\)[\s\S]+subscription_cycles has rows/);
    expect(sql).toMatch(/DROP TABLE IF EXISTS public\.subscription_external_refs/);
  });

  it("removes provider cycle ownership from cycles and commerce orders", () => {
    expect(sql).toContain("DROP COLUMN IF EXISTS provider_cycle_id");
    expect(sql).toContain("DROP COLUMN IF EXISTS provider_kind");
    expect(sql).toContain("DROP COLUMN IF EXISTS provider_charge_id");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS subscription_cycle_id uuid");
  });

  it("adds engine-owned snapshots, retry fields, and idempotency", () => {
    expect(sql).toContain("template_snapshot jsonb NOT NULL");
    expect(sql).toContain("pricing_snapshot jsonb NOT NULL");
    expect(sql).toContain("retry_attempt integer NOT NULL DEFAULT 0");
    expect(sql).toContain("engine_idempotency_key text NOT NULL");
    expect(sql).toContain("subscription_cycles_engine_idempotency_key_key");
  });

  it("creates admin-only audit events with unique idempotency", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.subscription_events");
    expect(sql).toContain("ALTER TABLE public.subscription_events ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("CREATE POLICY \"admin_all_subscription_events\"");
    expect(sql).toContain("subscription_events_idempotency_key_key");
  });
});
