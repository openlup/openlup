import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { allMigrations, effectiveFunctionBody } from "../test/effectiveMigration.js";
import { managedFunction } from "../test/managedSchema.js";

const symbols = ["subscription_apply_payment_success", "subscription_apply_payment_failure", "subscription_record_missing_payment_method"];
const migration = symbols.map(managedFunction).join("\n");
const schema = allMigrations().map(({ content }) => content).join("\n");

describe("subscription payment result boundary", () => {
  it("keeps historical service-role-only payment result RPC symbols", () => {
    for (const required of [
      "FUNCTION public.subscription_apply_payment_success",
      "FUNCTION public.subscription_apply_payment_failure",
      "FUNCTION public.subscription_record_missing_payment_method",
      "SECURITY DEFINER",
      "FROM anon",
      "FROM authenticated",
      "TO service_role",
    ]) {
      expect(migration).toContain(required);
    }
  });

  it("supersedes legacy success/failure RPCs with a payment-control guard", () => {
    for (const name of symbols.slice(0, 2)) {
      const guard = effectiveFunctionBody(name);
      expect(guard).toContain(`FUNCTION public.${name}`);
      for (const required of [
        "subscription_payment_result_deprecated_use_payment_control",
        "commerce_payment_control_apply_result",
        "as the canonical payment-result writer.",
      ]) expect(guard, name).toContain(required);
    }
  });

  it("keeps shipment gating but no longer treats subscription RPCs as canonical payment writers", () => {
    const shipmentGuard = effectiveFunctionBody("commerce_guard_paid_order_shipment_ref");
    const registrations = [...schema.matchAll(
      /^CREATE TRIGGER trg_commerce_guard_paid_order_shipment_ref\b[^;]*;/gm,
    )];
    expect(registrations).toHaveLength(1);
    expect(registrations[0]![0]).toContain(
      "BEFORE INSERT OR UPDATE ON public.shipment_external_refs FOR EACH ROW EXECUTE FUNCTION public.commerce_guard_paid_order_shipment_ref()",
    );
    expect(shipmentGuard).toContain("commerce_orders.id = NEW.order_id");
    expect(shipmentGuard).toContain("commerce_orders.status IN ('paid', 'fulfillment_pending', 'fulfilled')");
    expect(shipmentGuard).toContain("commerce_orders.mode <> 'subscription_cycle'");
    expect(shipmentGuard).toContain("OR subscription_cycles.status = 'paid'");
    expect(shipmentGuard).toContain("RAISE EXCEPTION 'commerce_shipment_requires_paid_order'");
    for (const name of symbols.slice(0, 2)) {
      const guard = effectiveFunctionBody(name);
      for (const table of ["commerce_orders", "commerce_payments", "subscription_cycles", "subscriptions"]) {
        expect(guard, name).not.toContain(`UPDATE public.${table}`);
      }
    }
  });

  it("proves legacy payment-result RPCs fail fast locally", () => {
    const deprecationProbe = read("docs/sql/subscription_payment_result_deprecation_probe.sql");
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
