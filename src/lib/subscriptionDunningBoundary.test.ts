import { describe, expect, it } from "vitest";
import { managedFunction, managedTable } from "../test/managedSchema";

const names = ["subscription_activate_from_paid_checkout_order", "subscription_handle_payment_failure_dunning", "subscription_handle_payment_failure_dunning_before_cancel_fence", "subscription_mark_dunning_recovered", "subscription_record_payment_recovery_request", "subscription_resume_from_dunning_with_cycle_order"];
const migration = names.map(managedFunction).join("\n");
const tables = ["subscription_dunning_cases", "subscription_dunning_notifications", "subscription_payment_recovery_tokens"].map(managedTable).join("\n");

describe("hidden subscription activation and dunning boundary", () => {
  it("stores durable dunning ledgers and bounded hashed recovery tokens", () => {
    expect(tables).toContain("token_hash text NOT NULL");
    expect(tables).toContain("purpose = ANY (ARRAY['repair_payment'::text, 'resume_subscription'::text])");
    expect(tables).toContain("UNIQUE (cycle_id)");
    expect(tables).toContain("UNIQUE (idempotency_key)");
  });

  it("keeps every activation, dunning and recovery RPC service-role-only", () => {
    for (const name of names.filter((name) => name !== "subscription_handle_payment_failure_dunning_before_cancel_fence")) {
      const sql = managedFunction(name);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${name}`);
      expect(sql).toMatch(new RegExp(`GRANT ALL ON FUNCTION public\\.${name}\\([^;]+ TO service_role;`));
      expect(sql).not.toMatch(/GRANT [^;]+ TO (?:PUBLIC|anon|authenticated);/);
    }
  });

  it("blocks accidental one-time activation and missing reusable payment methods", () => {
    for (const required of [
      "p_payment_method_ref IS NULL OR btrim(p_payment_method_ref) = ''",
      "subscription_activation_not_subscription_checkout",
      "subscription_activation_missing_cadence",
      "subscription_activation_order_not_paid",
      "subscription_activation_payment_not_succeeded",
    ]) {
      expect(migration).toContain(required);
    }
  });

  it("queues customer/admin dunning notifications and records missing admin recipients", () => {
    for (const required of [
      "subscription-payment-failed-1",
      "subscription-payment-failed-2",
      "subscription-payment-failed-3",
      "subscription-payment-expired",
      "subscription-payment-failed-admin",
      "subscription-payment-expired-admin",
      "commerce_payment_critical",
      "missing_commerce_payment_critical_recipient",
    ]) {
      expect(migration).toContain(required);
    }
  });

  it("supports expired resume by creating a fresh cycle order through the existing boundary", () => {
    for (const required of [
      "CREATE FUNCTION public.subscription_resume_from_dunning_with_cycle_order",
      "v_token.purpose <> 'resume_subscription'",
      "v_case.status <> 'expired'",
      "subscription_dunning_resume_cycle_number_not_fresh",
      "public.subscription_create_cycle_order_with_outbox",
      "'cycleOrder', v_cycle_order_body",
    ]) {
      expect(migration).toContain(required);
    }
  });

  it("expires dunning by pausing the subscription without writing payment tables directly", () => {
    expect(migration).toContain("SET status = 'paused'");
    expect(migration).toContain("'payment_failed_expired'");
    expect(migration).not.toContain("UPDATE public.commerce_payments");
    expect(migration).not.toContain("UPDATE public.commerce_payment_intents");
    expect(migration).not.toContain("stripe");
    expect(migration).not.toContain("tpay");
    expect(migration).not.toContain("fakturownia");
  });
});
