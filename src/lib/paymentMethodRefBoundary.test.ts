import { describe, expect, it } from "vitest";
import { allMigrations } from "../test/effectiveMigration";
import { managedFunction, managedTable } from "../test/managedSchema";

const table = managedTable("commerce_payment_method_refs");
const functions = [
  "commerce_payment_method_ref_upsert", "commerce_payment_method_ref_deactivate",
  "commerce_payment_method_ref_switch_active", "commerce_payment_method_ref_link_subscription_mirror",
] as const;
const migration = functions.map(managedFunction).join("\n");
const indexes = allMigrations().map(({ content }) => content).join("\n")
  .match(/^CREATE UNIQUE INDEX uniq_commerce_payment_method_refs_subscription_active[^;]*;/m)?.[0];

describe("hidden reusable payment method refs boundary", () => {
  it("stores provider-neutral reusable references with bounded families and uniqueness", () => {
    for (const field of ["provider_kind text NOT NULL", "consent_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL", "raw_provider_payload jsonb DEFAULT '{}'::jsonb NOT NULL", "UNIQUE (provider_kind, provider_method_ref)"]) expect(table).toContain(field);
    expect(table).toContain("method_kind = ANY (ARRAY['card'::text, 'blik_payid'::text, 'wallet'::text, 'alias'::text])");
    expect(table).toContain("status text DEFAULT 'pending_verification'::text NOT NULL");
    expect(indexes).toContain("WHERE (active AND (subscription_id IS NOT NULL))");
  });

  it("keeps every method-reference RPC service-role-only", () => {
    for (const name of functions) {
      const sql = managedFunction(name);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${name}`);
      expect(sql).toMatch(new RegExp(`GRANT ALL ON FUNCTION public\\.${name}\\([^;]+ TO service_role;`));
      expect(sql).not.toMatch(/GRANT [^;]+ TO (?:PUBLIC|anon|authenticated);/);
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
      "RETURN jsonb_set(v_existing.response_payload, '{paymentMethodRef,replayed}', 'true'::jsonb, true)",
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
