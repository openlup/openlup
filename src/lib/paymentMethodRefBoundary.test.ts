import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = read("supabase/migrations/20260606160000_hidden_payment_method_refs.sql");

describe("hidden reusable payment method refs boundary", () => {
  it("adds a provider-neutral reusable payment method ledger", () => {
    for (const required of [
      "CREATE TABLE IF NOT EXISTS public.commerce_payment_method_refs",
      "provider_kind text NOT NULL",
      "method_kind text NOT NULL CHECK (method_kind IN ('card', 'blik_payid', 'wallet', 'alias'))",
      "status text NOT NULL DEFAULT 'pending_verification'",
      "consent_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb",
      "raw_provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb",
      "UNIQUE (provider_kind, provider_method_ref)",
      "uniq_commerce_payment_method_refs_subscription_active",
    ]) {
      expect(migration).toContain(required);
    }
  });

  it("keeps method-ref RPCs service-role-only", () => {
    for (const fn of [
      "commerce_payment_method_ref_upsert",
      "commerce_payment_method_ref_deactivate",
      "commerce_payment_method_ref_switch_active",
      "commerce_payment_method_ref_link_subscription_mirror",
    ]) {
      expect(migration).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${fn}`);
      expect(migration).toContain("FROM PUBLIC, anon, authenticated");
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}`);
      expect(migration).toContain("TO service_role");
    }
  });

  it("fails closed for inactive or expired active switches", () => {
    for (const required of [
      "payment_method_ref_active_requires_active_status",
      "payment_method_ref_expired_cannot_be_active",
      "payment_method_ref_cannot_become_active",
      "v_ref.status <> 'active'",
      "v_ref.expires_at IS NOT NULL AND v_ref.expires_at <= now()",
    ]) {
      expect(migration).toContain(required);
    }
  });

  it("uses idempotency for upserts and duplicate provider refs", () => {
    for (const required of [
      "v_scope constant text := 'commerce.payment_method_ref.upsert'",
      "FROM public.commerce_idempotency_keys",
      "payment_method_ref_idempotency_conflict",
      "ON CONFLICT (provider_kind, provider_method_ref) DO UPDATE",
      "RETURN v_existing.response_payload",
    ]) {
      expect(migration).toContain(required);
    }
  });

  it("links subscription mirrors without mutating subscription lifecycle", () => {
    const mirrorUpdate = /UPDATE public\.subscriptions\s+SET payment_method_ref = v_ref\.provider_method_ref,\s+payment_method_kind = v_ref\.method_kind,\s+updated_at = now\(\)\s+WHERE id = p_subscription_id;/m;

    expect(migration).toMatch(mirrorUpdate);
    expect(migration).toContain("'lifecycleMutated', false");
    expect(migration).not.toMatch(/UPDATE public\.subscriptions[\s\S]{0,220}status\s*=/);
    expect(migration).not.toContain("commerce_payment_control_apply_result");
    expect(migration).not.toContain("subscription_handle_payment_failure_dunning");
  });
});

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}
