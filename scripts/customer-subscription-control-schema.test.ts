import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILE = "db/platform/migrations/20260813200000_customer_subscription_control.sql";
const sql = readFileSync(FILE, "utf8");

describe("public customer subscription-control rail", () => {
  it("grants actor-only routine access", () => {
    expect(sql).toContain("v_principal_id := auth.uid()");
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.customer_subscription_[\s\S]+FROM PUBLIC, anon/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.customer_subscription_[\s\S]+TO authenticated/);
    expect(sql).not.toMatch(/TO (?:PUBLIC|anon);/);
  });

  it("keeps a narrow neutral schema and excludes managed-only evidence", () => {
    expect(sql).toContain("CREATE TABLE public.subscription_lines");
    expect(sql).toContain("CREATE TABLE public.subscription_edit_quotes");
    expect(sql).toContain("customer_subscription_control_snapshot_as_actor");
    expect(sql).toContain("customer_subscription_preview_bundle_as_actor");
    expect(sql).toContain("customer_subscription_apply_bundle_as_actor");
    const executableSql = sql.split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(executableSql).not.toMatch(/pets|addresses|dunning|provider_customer|payment_method|invoice/i);
  });

  it("pins ownership, edit window, catalog pricing and replay identity", () => {
    expect(sql).toContain("client.principal_id = v_principal_id");
    expect(sql).toContain("subscription_edit_window_closed");
    expect(sql).toContain("subscription_lifecycle_assert_unlocked_cycle");
    expect(sql).toContain("price.mode IN ('subscription', 'any')");
    expect(sql).toContain("subscription_edit_idempotency_conflict");
    expect(sql).toContain("v_quote.accepted_event_id <> v_existing.id");
  });
});
