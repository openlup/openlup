import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const migration = read("supabase/migrations/20260601170000_order_draft_rpc_outbox.sql");
const probe = read("docs/sql/commerce_order_draft_rpc_rehearsal_probe.sql");
const report = read("docs/archive/supabase/SUPABASE_REHEARSAL_REPORT_DB5_2026-06-01.md");
const prodReport = read("docs/archive/supabase/SUPABASE_PROD_APPLY_REPORT_DB12_2026-06-05.md");
const driftMatrix = read("docs/SUPABASE_MIGRATION_DRIFT_MATRIX.md");
const preflight = read("docs/ECOMMERCE_ORDER_DRAFT_DB_ACTIVATION_PREFLIGHT.md");
const handoff = read("docs/ECOMMERCE_READINESS_HANDOFF.md");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("ecommerce order draft DB rehearsal candidate", () => {
  it("adds the outbox table and RPC candidate without public grants", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.outbox_events");
    expect(migration).toContain("UNIQUE (event_type, idempotency_key)");
    expect(migration).toContain("ALTER TABLE public.outbox_events ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.commerce_create_order_draft_with_outbox");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path = public, pg_catalog");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.commerce_create_order_draft_with_outbox(text, jsonb, jsonb) FROM PUBLIC");
    expect(migration).toContain("GRANT SELECT, INSERT, UPDATE ON TABLE public.outbox_events TO service_role");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.commerce_create_order_draft_with_outbox(text, jsonb, jsonb) TO service_role");
    expect(migration).not.toMatch(/\bGRANT\b[\s\S]*?\bTO\s+(anon|authenticated)\b/i);
    expect(migration).not.toMatch(/\bCREATE POLICY\b/i);
    expect(migration).not.toMatch(/\bstripe\b/i);
  });

  it("keeps order draft writes atomic and idempotent inside one RPC", () => {
    const requiredPhrases = [
      "v_scope constant text := 'commerce.order_draft.create'",
      "v_event_type constant text := 'commerce.order_draft.created'",
      "v_request_fingerprint := md5",
      "FOR UPDATE",
      "status = 'completed'",
      "jsonb_set(v_existing.response_payload, '{orderDraft,replayed}', 'true'::jsonb",
      "commerce_order_draft_idempotency_conflict",
      "INSERT INTO public.commerce_orders",
      "INSERT INTO public.outbox_events",
      "UPDATE public.commerce_idempotency_keys",
    ];

    for (const phrase of requiredPhrases) {
      expect(migration).toContain(phrase);
    }
  });

  it("does not require active catalog persistence for first order draft items", () => {
    expect(migration).toMatch(/INSERT INTO public\.commerce_order_items[\s\S]*?sku_id[\s\S]*?NULL/i);
    expect(migration).toContain("'productSlug', v_line->>'productSlug'");
    expect(migration).toContain("'quoteLine', v_line");
    expect(migration).toContain("'source', 'commerce.order_draft.bff.v0'");
  });

  it("ships a rollback-only probe for rehearsal target verification", () => {
    const requiredPhrases = [
      "BEGIN;",
      "ROLLBACK;",
      "wave7-probe-success",
      "wave7-probe-discount-shipping",
      "expected idempotency conflict",
      "order-draft canonical item money was not persisted",
      "discount + free-shipping order did not persist canonical money",
      "has_table_privilege('anon', 'public.outbox_events', 'SELECT')",
      "public.commerce_create_order_draft_with_outbox(text,jsonb,jsonb,uuid)",
    ];

    for (const phrase of requiredPhrases) {
      expect(probe).toContain(phrase);
    }
  });

  it("records the local rehearsal result and later production apply boundary", () => {
    expect(report).not.toContain("TBD");
    expect(report).toContain("Target type: `local-supabase-orbstack`");
    expect(report).toContain("Replay, conflict, rollback, and atomic outbox probes: `passed`");
    expect(report).toContain("Did any command mutate production? `No`");
    expect(report).toContain("Final recommendation: `LOCAL GO; PRODUCTION APPLY NO-GO`");
    expect(handoff).toContain("DB5 order-draft RPC/outbox");
    expect(driftMatrix).toContain("SUPABASE_REHEARSAL_REPORT_DB21_2026-06-12.md");
    expect(driftMatrix).toContain("SUPABASE_PROD_APPLY_REPORT_DB12_2026-06-05.md");
    expect(prodReport).toContain("20260605133000_hidden_checkout_runtime.sql");
    expect(prodReport).toContain("Remote database is up to date.");
    expect(handoff).toContain("Order-draft lineage & eventing");
    expect(handoff).toContain("DB5 applied the hidden DB5 order-draft RPC/outbox production schema");
    expect(preflight).toContain("20260601170000_order_draft_rpc_outbox.sql");
    expect(preflight).toContain("DB5 APPLIED");
    expect(handoff).toContain("DB5 order-draft RPC/outbox");
  });
});
