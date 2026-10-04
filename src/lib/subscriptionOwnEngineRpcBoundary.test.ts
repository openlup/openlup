import { describe, expect, it } from "vitest";

import { effectiveFunctionBody } from "../test/effectiveMigration";
import { currentTableStatements, currentTrigger, explicitFunctionExecuteRoles } from "../test/historicalBoundarySchema";

const cycleOrderRpc = effectiveFunctionBody("subscription_create_cycle_order_with_outbox");
const renewalDue = effectiveFunctionBody("subscription_list_due_for_renewal");
const cycleOrderDdl = [currentTableStatements("commerce_orders"), currentTableStatements("subscription_cycles")].join("\n");
const templateGuardMigration = [effectiveFunctionBody("subscription_current_template_snapshot"), effectiveFunctionBody("subscription_guard_payment_pending_cycle_template"), currentTrigger("trg_subscription_guard_payment_pending_cycle_template")].join("\n");

describe("subscription own-engine RPC boundary", () => {
  it("keeps the cycle-order RPC a definer function with a fixed idempotency scope", () => {
    expect(cycleOrderRpc).toContain("CREATE FUNCTION public.subscription_create_cycle_order_with_outbox");
    expect(cycleOrderRpc).toContain("SECURITY DEFINER");
    expect(cycleOrderRpc).toContain("v_scope constant text := 'subscription.cycle_order.create'");
  });

  it("keeps the cycle-order RPC service-role-only", () => {
    for (const roles of explicitFunctionExecuteRoles("subscription_create_cycle_order_with_outbox").values()) {
      expect(roles.has("service_role")).toBe(true);
      for (const role of ["PUBLIC", "anon", "authenticated"]) expect(roles.has(role)).toBe(false);
    }
  });

  it("atomically writes the own-engine cycle, order, payment intent, outbox, and audit event", () => {
    for (const required of [
      "INSERT INTO public.subscription_cycles",
      "INSERT INTO public.commerce_orders",
      "INSERT INTO public.commerce_order_items",
      "INSERT INTO public.commerce_payments",
      "INSERT INTO public.outbox_events",
      "INSERT INTO public.subscription_events",
      "commerce.subscription_payment.requested",
      "subscription.payment_requested",
    ]) {
      expect(cycleOrderRpc).toContain(required);
    }
  });

  it("guards against duplicate subscription-cycle orders", () => {
    expect(cycleOrderDdl).toContain("commerce_orders_subscription_cycle_mode_check");
    expect(cycleOrderDdl).toContain("commerce_orders_subscription_cycle_id_key");
    expect(cycleOrderDdl).toContain("subscription_cycles_order_id_key");
    expect(cycleOrderRpc).toContain("jsonb_set(");
    expect(cycleOrderRpc).toContain("subscription_cycle_order_idempotency_conflict");
  });

  it("rejects stale payment-pending cycle template snapshots at the DB boundary", () => {
    for (const required of [
      "subscription_current_template_snapshot",
      "FOR UPDATE",
      "JOIN public.catalog_skus",
      "subscription_lines",
      "trg_subscription_guard_payment_pending_cycle_template",
      "subscription_cycle_order_stale_template_snapshot",
    ]) {
      expect(templateGuardMigration).toContain(required);
    }
  });

  it("keeps renewal due selection from creating duplicate open cycles", () => {
    expect(renewalDue).toMatch(/CREATE (?:OR REPLACE )?FUNCTION public\.subscription_list_due_for_renewal/u);
    const retryLane = renewalDue.split("WITH retry_due AS (")[1]!.split("normal_due AS (")[0]!;
    const normalLane = renewalDue.split("normal_due AS (")[1]!.split("SELECT *\n      FROM (")[0]!;
    for (const lane of [retryLane, normalLane]) {
      expect(lane.match(/FOR UPDATE OF s SKIP LOCKED/gu)).toHaveLength(1);
      expect(lane).toMatch(/LIMIT p_limit\s+FOR UPDATE OF s SKIP LOCKED/u);
    }
    for (const required of [

      "c.status = 'retry_scheduled'",
      "c.next_retry_at <= p_as_of",
      // The open-cycle guard, and it is strictly wider than the retry/pending pair
      // this test used to pin: a terminal payment_failed cycle also blocks a new one.
      "c.status IN ('payment_pending', 'retry_scheduled', 'payment_failed')",
      "FOR UPDATE OF s SKIP LOCKED",
    ]) {
      expect(renewalDue).toContain(required);
    }
  });

});
