import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const migration = read("supabase/migrations/20260605100000_commerce_v2_phase1_hidden_oms.sql");
const hardeningMigration = read("supabase/migrations/20260613221000_admin_oms_preview_hardening.sql");
// The LIVE body of public.commerce_oms_admin_list_queue: the one an admin queue
// request actually executes. Until W0 these assertions read three SUPERSEDED
// migrations (20260614143000_admin_oms_queue_aggregates,
// 20260704180000_admin_oms_paid_summary_totals,
// 20260704190000_admin_dashboard_command_center_queue), each of which had since
// been fully replaced. They therefore proved nothing about production.
const liveQueueMigration = read("supabase/migrations/20260816082705_oms_queue_summary_single_currency.sql");
const probe = read("docs/sql/commerce_oms_hold_rehearsal_probe.sql");
const queueProbe = read("docs/sql/commerce_oms_queue_aggregates_probe.sql");

describe("commerce OMS hidden boundary", () => {
  it("adds OMS hold and operation tables without payment-control result logic", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.commerce_order_holds");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.commerce_order_operations");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.commerce_oms_create_hold");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.commerce_oms_release_hold");
    expect(migration).not.toContain("commerce_payment_control_apply_result");
    expect(migration).not.toContain("commerce_payment_state_transitions");
  });

  it("keeps hold RPCs service-role-only and rehearses payment-control non-mutation", () => {
    for (const required of [
      "TO service_role",
      "commerce_oms_hold_replay_failed",
      "commerce_oms_touched_payment_control_tables",
      "commerce_oms_hold_rpc_publicly_exposed",
      "ROLLBACK",
    ]) {
      expect(`${migration}\n${probe}`).toContain(required);
    }
  });

  it("keeps hidden OMS routes out of the current production UI", () => {
    const uiFiles = [
      ...readFiles(join(repoRoot, "src/pages")),
      ...readFiles(join(repoRoot, "src/components")),
      join(repoRoot, "src/App.tsx"),
      join(repoRoot, "src/main.tsx"),
    ]
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => !/\.(test|spec)\./.test(file))
      .filter((file) => !isAllowedAdminOmsPreviewFile(file));

    const violations = uiFiles.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [/\/api\/bff\/admin\/commerce\//, /omsClient/, /commerceOms/i]
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${relativePath(file)} -> ${pattern}`);
    });

    expect(violations).toEqual([]);
  });


  it("hardens admin OMS preview address correction behind a service-role RPC", () => {
    expect(hardeningMigration).toContain("'shipping_address_updated'");
    expect(hardeningMigration).toContain("CREATE OR REPLACE FUNCTION public.commerce_oms_update_shipping_address");
    expect(hardeningMigration).toContain("commerce_oms_shipping_address_locked_after_label");
    expect(hardeningMigration).toContain("shipping_address_snapshot = v_shipping_address_snapshot");
    expect(hardeningMigration).toContain("TO service_role");
  });

  it("keeps the live admin OMS queue aggregate read model service-role-only", () => {
    expect(liveQueueMigration).toContain("CREATE OR REPLACE FUNCTION public.commerce_oms_admin_list_queue");
    expect(liveQueueMigration).toContain("STABLE");
    expect(liveQueueMigration).toContain("SECURITY DEFINER");
    expect(liveQueueMigration).toContain("summaryCounts");
    expect(liveQueueMigration).toContain("fulfillment_blocked");
    expect(liveQueueMigration).toContain("review_fulfillment");
    expect(liveQueueMigration).toContain("TO service_role");
    expect(liveQueueMigration).toContain("FROM PUBLIC, anon, authenticated");
  });

  // The provider-coupling MEASUREMENT that used to live here as an assertion has
  // moved to docs/plan/oms-w0-honest-proof.md (finding 4). It pinned a token
  // count inside a forward migration, and forward migrations are immutable, so
  // the assertion could never go red - it was a finding wearing a test's
  // clothes, which is the exact defect this wave exists to remove. The finding
  // itself (the live body names OmniPack in 13 places) is recorded where
  // findings belong, and the OSS readiness scanner already measures that
  // vocabulary continuously against its own baseline.

  it("documents a rollback-only probe for Admin OMS queue pagination beyond 500", () => {
    expect(queueProbe).toContain("generate_series(1, 506)");
    expect(queueProbe).toContain("commerce_oms_queue_beyond_500_wrong");
    expect(queueProbe).toContain("summaryCounts,readyForFulfillment");
    expect(queueProbe).toContain("commerce_oms_queue_rpc_grants_wrong");
    expect(queueProbe).toContain("ROLLBACK");
  });

  it("keeps admin dashboard summary totals paid-only in the live queue RPC", () => {
    expect(liveQueueMigration).toContain("summaryTotals");
    // The paid set is now selected through latest_summary_payment, so the live
    // predicate reads `payment.payment_status`, not the `operational.` column
    // the superseded migration named.
    expect(liveQueueMigration).toContain("payment.payment_status = 'succeeded'");
    expect(liveQueueMigration).not.toContain("'orderCount', (SELECT count(*) FROM base_orders)");
  });

  it("keeps the live command-center queue honest and paid-time based", () => {
    // No parameter of the live overload carries a DEFAULT: every caller must
    // pass all sixteen arguments positionally.
    expect(liveQueueMigration).toContain("p_attention_only boolean");
    expect(liveQueueMigration).toContain("p_next_action text");
    expect(liveQueueMigration).not.toContain("DEFAULT");
    expect(liveQueueMigration).toContain("attention_priority_desc");
    expect(liveQueueMigration).toContain("WHEN order_status IN ('refunded', 'cancelled') THEN 'none'");
    expect(liveQueueMigration).toContain("coalesce(p_attention_only, false) = false OR attention_reason <> 'none'");
    expect(liveQueueMigration).toContain("p_next_action IS NULL OR next_action = p_next_action");
    expect(liveQueueMigration).toContain("payment.status IN ('succeeded', 'paid')");
    expect(liveQueueMigration).toContain("payment.paid_at >= v_from");
    expect(liveQueueMigration).not.toContain("'orderCount', (SELECT count(*) FROM base_orders)");
  });
});

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function isAllowedAdminOmsPreviewFile(file: string): boolean {
  const path = relativePath(file);
  return new Set([
    "src/App.tsx",
    "src/components/admin/AdminLayout.tsx",
    // Shell OMS attention badge; its query is gated on isAdminOmsSurfaceAllowed()
    // so no OMS request is issued where the surface is hidden.
    "src/components/admin/useAdminShellData.ts",
    "src/pages/admin/DashboardPage.tsx",
    // Recovery-baseline read. Its route is gated on isAdminOmsSurfaceAllowed(),
    // exactly like the orders queue it sits beside, so the page never mounts and
    // issues no OMS request where the surface is hidden.
    "src/pages/admin/DunningRecoveryPage.tsx",
    "src/pages/admin/OrderDetailBlocks.tsx",
    "src/pages/admin/OrderDetailSections.tsx",
    "src/pages/admin/OrderDetailSheet.tsx",
    "src/pages/admin/OrdersPage.tsx",
    "src/pages/admin/OrdersPageTable.tsx",
    "src/pages/admin/ordersPageUtils.ts",
  ]).has(path);
}

function readFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return readFiles(fullPath);
    return [fullPath];
  });
}

function relativePath(file: string): string {
  return relative(repoRoot, file).split(sep).join("/");
}
