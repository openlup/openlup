import { effectiveFunctionBody } from "../test/effectiveMigration";
import { currentTableStatements, explicitFunctionExecuteRoles } from "../test/historicalBoundarySchema";
import { describe, expect, it } from "vitest";

const functions = ["commerce_payment_method_ref_upsert", "commerce_payment_method_ref_deactivate", "commerce_payment_method_ref_switch_active", "commerce_payment_method_ref_link_subscription_mirror"];
const ledger = currentTableStatements("commerce_payment_method_refs");
const migration = [ledger, ...functions.map(effectiveFunctionBody)].join("\n");

describe("hidden reusable payment method refs boundary", () => {
  it("adds a provider-neutral reusable payment method ledger", () => {
    for (const required of [
      "CREATE TABLE public.commerce_payment_method_refs",
      "provider_kind text NOT NULL",
      "commerce_payment_method_refs_method_kind_check",
      "status text DEFAULT 'pending_verification'::text NOT NULL",
      "consent_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL",
      "raw_provider_payload jsonb DEFAULT '{}'::jsonb NOT NULL",
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
      expect(effectiveFunctionBody(fn)).toContain("SECURITY DEFINER");
      for (const roles of explicitFunctionExecuteRoles(fn).values()) {
        expect(roles.has("service_role")).toBe(true);
        for (const role of ["PUBLIC", "anon", "authenticated"]) expect(roles.has(role)).toBe(false);
      }
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
      "RETURN jsonb_set(v_existing.response_payload, '{paymentMethodRef,replayed}'",
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
