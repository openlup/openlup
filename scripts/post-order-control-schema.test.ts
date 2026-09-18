import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILE = "db/platform/migrations/20260813230000_post_order_control.sql";
const BRIDGE_FILE = "db/platform/migrations/20260817100000_oms_control_plane_operator_bridge.sql";
const sql = readFileSync(FILE, "utf8");
const bridgeSql = readFileSync(BRIDGE_FILE, "utf8");
const executableSql = sql.replace(/^\s*--.*$/gm, "");

describe("post-order control public forward", () => {
  it("owns durable risk, return and recovery ledgers", () => {
    expect(sql).toContain("risk_manual_review_cases");
    expect(sql).toContain("commerce_return_operations");
    expect(sql).toContain("outbox_requeue_discarded");
  });
  it("keeps provider payloads and privileged function bodies out", () => {
    expect(executableSql).not.toMatch(/resend_id|stripe_|omnipack_|provider_payload|SECURITY\s+DEFINER/i);
    expect(executableSql).not.toMatch(/^\s*GRANT\s+/im);
  });
});

describe("OMS control-plane operator bridge", () => {
  it("requires both active Platform-control and Commerce ownership without provisioning", () => {
    expect(bridgeSql).toContain("platform_control_operators");
    expect(bridgeSql).toContain("commerce_operators");
    expect(bridgeSql).toContain("active IS TRUE");
    expect(bridgeSql).not.toMatch(/\bINSERT\b|SECURITY\s+DEFINER/i);
  });
  it("grants no browser authority", () => {
    expect(bridgeSql).toMatch(/REVOKE ALL[\s\S]+FROM PUBLIC, anon, authenticated/i);
    expect(bridgeSql).not.toMatch(/^\s*GRANT\s+/im);
  });
});
