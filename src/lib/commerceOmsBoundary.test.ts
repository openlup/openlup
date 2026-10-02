import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveFunctionBody } from "../test/effectiveMigration";
import { currentTableStatements, explicitFunctionExecuteRoles } from "../test/historicalBoundarySchema";

const repoRoot = process.cwd();
const holdNames = ["commerce_oms_create_hold", "commerce_oms_release_hold"];
const migration = [currentTableStatements("commerce_order_holds"), currentTableStatements("commerce_order_operations"), ...holdNames.map(effectiveFunctionBody)].join("\n");
const hardeningMigration = effectiveFunctionBody("commerce_oms_update_shipping_address");
const liveQueueMigration = effectiveFunctionBody("commerce_oms_admin_list_queue");

describe("commerce OMS hidden boundary", () => {
  it("adds OMS hold and operation tables without payment-control result logic", () => {
    expect(migration).toContain("CREATE TABLE public.commerce_order_holds");
    expect(migration).toContain("CREATE TABLE public.commerce_order_operations");
    expect(migration).toContain("CREATE FUNCTION public.commerce_oms_create_hold");
    expect(migration).toContain("CREATE FUNCTION public.commerce_oms_release_hold");
    expect(migration).not.toContain("commerce_payment_control_apply_result");
    expect(migration).not.toContain("commerce_payment_state_transitions");
  });

  it("keeps hold RPCs server-only without payment-control writes", () => {
    for (const name of holdNames) {
      const body = effectiveFunctionBody(name);
      expect(body).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM) public\.(?:commerce_payment_intents|commerce_payment_attempts|commerce_payments|commerce_payment_state_transitions)/);
      for (const roles of explicitFunctionExecuteRoles(name).values()) {
        expect(roles.has("service_role")).toBe(true);
        for (const role of ["PUBLIC", "anon", "authenticated"]) expect(roles.has(role)).toBe(false);
      }
    }
  });
  it("keeps hidden OMS routes out of the current production UI", () => {
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
    expect(hardeningMigration).toContain("commerce_oms_delivery_contact_submission_started");
    expect(hardeningMigration).toContain("v_fulfillment.status NOT IN ('created', 'packed', 'label_pending')");
    expect(hardeningMigration).toContain("shipping_address_snapshot = shipping_address_snapshot || jsonb_build_object(");
    expect(hardeningMigration).toContain("'deliveryContact', v_updated_contact");
    for (const roles of explicitFunctionExecuteRoles("commerce_oms_update_shipping_address").values()) {
      expect(roles.has("service_role")).toBe(true);
      for (const role of ["PUBLIC", "anon", "authenticated"]) expect(roles.has(role)).toBe(false);
    }
  });

  it("keeps the live admin OMS queue aggregate read model service-role-only", () => {
    expect(liveQueueMigration).toContain("CREATE FUNCTION public.commerce_oms_admin_list_queue");
    expect(liveQueueMigration).toContain("STABLE");
    expect(liveQueueMigration).toContain("SECURITY DEFINER");
    expect(liveQueueMigration).toContain("summaryCounts");
    expect(liveQueueMigration).toContain("fulfillment_blocked");
    expect(liveQueueMigration).toContain("review_fulfillment");
    for (const roles of explicitFunctionExecuteRoles("commerce_oms_admin_list_queue").values()) {
      expect(roles.has("service_role")).toBe(true);
      for (const role of ["PUBLIC", "anon", "authenticated"]) expect(roles.has(role)).toBe(false);
    }
  });

  // The provider-coupling MEASUREMENT that used to live here as an assertion has
  // moved to docs/plan/oms-w0-honest-proof.md (finding 4). It pinned a token
  // count inside a forward migration, and forward migrations are immutable, so
  // the assertion could never go red - it was a finding wearing a test's
  // clothes, which is the exact defect this wave exists to remove. The finding
  // itself (the live body names OmniPack in 13 places) is recorded where
  // findings belong, and the OSS readiness scanner already measures that
  // vocabulary continuously against its own baseline.


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
