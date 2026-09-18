import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = read("supabase/migrations/20260605170000_hidden_subscription_activation_dunning.sql");

describe("hidden subscription activation and dunning boundary", () => {
  it("adds durable dunning ledgers and hashed recovery token storage", () => {
    for (const required of [
      "CREATE TABLE IF NOT EXISTS public.subscription_dunning_cases",
      "CREATE TABLE IF NOT EXISTS public.subscription_dunning_notifications",
      "CREATE TABLE IF NOT EXISTS public.subscription_payment_recovery_tokens",
      "token_hash text NOT NULL",
      "purpose text NOT NULL CHECK (purpose IN ('repair_payment', 'resume_subscription'))",
      "UNIQUE (cycle_id)",
      "UNIQUE (idempotency_key)",
    ]) {
      expect(migration).toContain(required);
    }
  });

  it("keeps activation, dunning and recovery RPCs service-role-only", () => {
    for (const fn of [
      "subscription_activate_from_paid_checkout_order",
      "subscription_handle_payment_failure_dunning",
      "subscription_mark_dunning_recovered",
      "subscription_record_payment_recovery_request",
      "subscription_resume_from_dunning_with_cycle_order",
    ]) {
      expect(migration).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${fn}`);
      expect(migration).toContain("FROM PUBLIC, anon, authenticated");
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}`);
      expect(migration).toContain("TO service_role");
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
      "CREATE OR REPLACE FUNCTION public.subscription_resume_from_dunning_with_cycle_order",
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

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}
