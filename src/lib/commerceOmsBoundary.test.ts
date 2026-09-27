import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { managedFunction, managedTable } from "../test/managedSchema.js";

const repoRoot = process.cwd();
const holdFunctions = ["commerce_oms_create_hold", "commerce_oms_release_hold"];
const migration = [...["commerce_order_holds", "commerce_order_operations"].map(managedTable), ...holdFunctions.map(managedFunction)].join("\n");
const hardeningMigration = managedFunction("commerce_oms_update_shipping_address");
const liveQueueMigration = managedFunction("commerce_oms_admin_list_queue");

describe("published commerce OMS structural boundary", () => {
  it("adds OMS hold and operation tables without payment-control result logic", () => {
    expect(migration).toContain("CREATE TABLE public.commerce_order_holds");
    expect(migration).toContain("CREATE TABLE public.commerce_order_operations");
    expect(migration).toContain("CREATE FUNCTION public.commerce_oms_create_hold");
    expect(migration).toContain("CREATE FUNCTION public.commerce_oms_release_hold");
    expect(migration).not.toContain("commerce_payment_control_apply_result");
    expect(migration).not.toContain("commerce_payment_state_transitions");
  });

  it("declares hold RPC service-role access and rehearses payment-control non-mutation", () => {
    const probe = read("supabase/tests/commerce_oms_boundary_test.sql");
    for (const required of [
      "TO service_role",
      "same-input hold create replays",
      "same-input hold release replays",
      "preserves complete payment-control and protected rows",
      "SET LOCAL ROLE service_role",
      "SET LOCAL ROLE anon",
      "SET LOCAL ROLE authenticated",
      "42501",
      "ROLLBACK",
    ]) {
      expect(`${migration}\n${probe}`).toContain(required);
    }
  });

  it("keeps hidden OMS routes out of the published browser UI", () => {
    const uiFiles = [
      ...readFiles(join(repoRoot, "src/pages")),
      ...readFiles(join(repoRoot, "src/components")),
      join(repoRoot, "src/public-reference/App.tsx"),
      join(repoRoot, "src/public-reference/main.tsx"),
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
    expect(hardeningMigration).toContain("CREATE FUNCTION public.commerce_oms_update_shipping_address");
    expect(hardeningMigration).toContain("commerce_oms_shipping_address_locked_after_label");
    expect(hardeningMigration).toContain("shipping_address_snapshot = v_shipping_address_snapshot");
    expect(hardeningMigration).toContain("TO service_role");
  });

  it("declares the shipped admin OMS queue structure and service-role access", () => {
    expect(liveQueueMigration).toContain("CREATE FUNCTION public.commerce_oms_admin_list_queue");
    expect(liveQueueMigration).toContain("STABLE");
    expect(liveQueueMigration).toContain("SECURITY DEFINER");
    expect(liveQueueMigration).toContain("summaryCounts");
    expect(liveQueueMigration).toContain("fulfillment_blocked");
    expect(liveQueueMigration).toContain("review_fulfillment");
    expect(liveQueueMigration).toContain("TO service_role");
    // Source declaration is not effective ACL evidence; executable role-taking proof is separate.
    expect(liveQueueMigration).toContain("FROM PUBLIC;");
    expect(liveQueueMigration).not.toMatch(/GRANT [^;]+ TO (?:anon|authenticated|PUBLIC);/);
  });

  it("registers executed pgTAP queue pagination and global-summary proof beyond 500", () => {
    const queueProbe = read("supabase/tests/commerce_oms_boundary_test.sql");
    expect(queueProbe).toContain("generate_series(1, 506)");
    expect(queueProbe).toContain("sixth queue page exposes the six orders beyond 500");
    expect(queueProbe).toContain("summaryCounts,readyForFulfillment");
    expect(queueProbe).toContain("has_function_privilege");
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
