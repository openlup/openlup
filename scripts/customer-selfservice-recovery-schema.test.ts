import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILE = "db/platform/migrations/20260814090000_customer_selfservice_recovery.sql";
const sql = readFileSync(FILE, "utf8");
const statements = sql.replace(/^\s*--.*$/gm, "");

describe("portable customer self-service recovery rail", () => {
  it("stores hashes and actor-owned neutral facts, never raw credentials or provider evidence", () => {
    expect(statements).toContain("email_fingerprint text NOT NULL");
    expect(statements).toContain("token_hash text NOT NULL");
    expect(statements).toContain("v_principal_id uuid := auth.uid()");
    expect(statements).not.toMatch(/raw_token|access_token|refresh_token|client_secret|provider_attempt|webhook_payload/i);
    expect(statements).not.toMatch(/stripe|tpay|supabase|service_role/i);
  });

  it("grants only bounded actor routines and leaves service routines host-owned", () => {
    expect(statements).toMatch(/GRANT EXECUTE ON FUNCTION public\.customer_communication_preferences_as_actor\(\) TO authenticated/);
    expect(statements).toMatch(/GRANT EXECUTE ON FUNCTION public\.customer_checkout_recovery_token_issue_as_actor[\s\S]+TO authenticated/);
    expect(statements).not.toMatch(/GRANT[\s\S]+customer_identity_challenge/);
    expect(statements).not.toMatch(/GRANT[\s\S]+customer_checkout_recovery_settle/);
    expect(statements).not.toMatch(/TO (?:PUBLIC|anon);/);
  });

  it("pins single consumption, actor ownership and exact-key settlement replay", () => {
    expect(statements).toContain("v_challenge.used_at IS NOT NULL");
    expect(statements).toContain("client.principal_id = auth.uid()");
    expect(statements).toContain("p_idempotency_key || ':settle'");
    expect(statements).toContain("commerce_record_settlement");
  });
});
