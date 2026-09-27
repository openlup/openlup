import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { effectiveFunctionBody, effectiveGrantMigration } from "../test/effectiveMigration";

// LIVE bodies, not the migrations that introduced them. Until W4a this file read
// 20260604180000 for the cycle-order RPC (two full-body replaces later:
// 20260714170003 canonical order money, 20260816164246 currency invariant) and
// 20260610225000 for renewal due selection (five replaces later, newest
// 20260805090000). Both sets of assertions passed against text the database had
// stopped running.
const cycleOrderRpc = effectiveFunctionBody("subscription_create_cycle_order_with_outbox");
const renewalDue = effectiveFunctionBody("subscription_list_due_for_renewal");

// Privileges are resolved separately: CREATE OR REPLACE preserves them, so the
// migration that last GRANTed is not in general the one that last defined.
const cycleOrderGrants = effectiveGrantMigration("subscription_create_cycle_order_with_outbox").content;

// One-time DDL is not superseded by a body replace, so it stays pinned to the
// migration that created it: the constraint and the two unique indexes that make
// a duplicate subscription-cycle order impossible, and the payment-pending
// template-snapshot trigger (single definition in the whole corpus).
const cycleOrderDdl = read("supabase/migrations/20260604180000_commerce_v2_w7d_subscription_cycle_order_rpc.sql");
const templateGuardMigration = read(
  "supabase/migrations/20260605144000_subscription_cycle_template_snapshot_guard.sql",
);
const probe = read("docs/sql/subscription_cycle_order_rpc_rehearsal_probe.sql");

describe("subscription own-engine RPC boundary", () => {
  it("keeps the cycle-order RPC a definer function with a fixed idempotency scope", () => {
    expect(cycleOrderRpc).toContain("CREATE OR REPLACE FUNCTION public.subscription_create_cycle_order_with_outbox");
    expect(cycleOrderRpc).toContain("SECURITY DEFINER");
    expect(cycleOrderRpc).toContain("v_scope constant text := 'subscription.cycle_order.create'");
  });

  it("keeps the cycle-order RPC service-role-only", () => {
    expect(cycleOrderGrants).toContain("REVOKE ALL ON FUNCTION public.subscription_create_cycle_order_with_outbox");
    expect(cycleOrderGrants).toContain("FROM anon");
    expect(cycleOrderGrants).toContain("FROM authenticated");
    expect(cycleOrderGrants).toContain("TO service_role");
    expect(cycleOrderGrants).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.subscription_create_cycle_order_with_outbox\b[^;]*\bTO\s+[^;]*\b(?:PUBLIC|anon|authenticated)\b/i,
    );
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
    for (const required of [
      "CREATE OR REPLACE FUNCTION public.subscription_list_due_for_renewal",
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

  it("keeps the rehearsal probe focused on replay, conflict, atomic rollback and public-role denial", () => {
    for (const required of [
      "ROLLBACK",
      "sub-cycle-probe-success",
      "expected exactly one payment outbox event after replay",
      "expected subscription_cycle order without cycle FK to fail",
      "expected idempotency conflict",
      "failed outbox call left a cycle behind",
      "has_function_privilege(",
      "authenticated",
    ]) {
      expect(probe).toContain(required);
    }
  });
});

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}
