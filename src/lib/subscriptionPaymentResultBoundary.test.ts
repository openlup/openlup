import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = read("supabase/migrations/20260604183000_commerce_v2_w7e_subscription_payment_result.sql");
const guardMigration = read(
  "supabase/migrations/20260605143000_commerce_payment_control_legacy_subscription_guard.sql",
);
const deprecationProbe = read("docs/sql/subscription_payment_result_deprecation_probe.sql");

describe("subscription payment result boundary", () => {
  it("keeps historical service-role-only payment result RPC symbols", () => {
    for (const required of [
      "CREATE OR REPLACE FUNCTION public.subscription_apply_payment_success",
      "CREATE OR REPLACE FUNCTION public.subscription_apply_payment_failure",
      "CREATE OR REPLACE FUNCTION public.subscription_record_missing_payment_method",
      "SECURITY DEFINER",
      "FROM anon",
      "FROM authenticated",
      "TO service_role",
    ]) {
      expect(migration).toContain(required);
    }
  });

  it("supersedes legacy success/failure RPCs with a payment-control guard", () => {
    for (const required of [
      "CREATE OR REPLACE FUNCTION public.subscription_apply_payment_success",
      "CREATE OR REPLACE FUNCTION public.subscription_apply_payment_failure",
      "subscription_payment_result_deprecated_use_payment_control",
      "commerce_payment_control_apply_result",
      "Payment-control is the canonical payment-result writer",
    ]) {
      expect(guardMigration).toContain(required);
    }
  });

  it("keeps shipment gating but no longer treats subscription RPCs as canonical payment writers", () => {
    expect(migration).toContain("commerce_guard_paid_order_shipment_ref");
    expect(guardMigration).not.toContain("UPDATE public.commerce_orders");
    expect(guardMigration).not.toContain("UPDATE public.commerce_payments");
    expect(guardMigration).not.toContain("UPDATE public.subscription_cycles");
    expect(guardMigration).not.toContain("UPDATE public.subscriptions");
  });

  it("proves legacy payment-result RPCs fail fast locally", () => {
    for (const required of [
      "subscription_apply_payment_success",
      "subscription_apply_payment_failure",
      "subscription_payment_result_deprecated_use_payment_control",
      "unexpectedly mutated state",
      "ROLLBACK",
    ]) {
      expect(deprecationProbe).toContain(required);
    }
  });
});

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}
