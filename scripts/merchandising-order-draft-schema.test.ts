import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILE = "db/platform/migrations/20260813220000_merchandising_order_draft.sql";
const sql = readFileSync(FILE, "utf8");

describe("merchandising order draft public forward", () => {
  it("stores only token hashes and bounded redacted state", () => {
    expect(sql).toContain("commerce_checkout_resume_drafts_token_hash_check");
    expect(sql).toContain("jsonb_typeof(draft_state) = 'object'");
    expect(sql).not.toMatch(/raw_token|recipient_email|shipping_address|payment_provider_id/i);
  });

  it("owns one atomic catalog-validated draft and outbox receipt", () => {
    expect(sql).toContain("commerce_create_order_draft_with_outbox");
    expect(sql).toContain("commerce_order_draft_catalog_price_changed");
    expect(sql).toContain("commerce_order_draft_receipts");
    expect(sql).toContain("commerce.order_draft.created");
    expect(sql).toContain("pg_advisory_xact_lock");
  });

  it("does not grant the operator tables or routines to public actors", () => {
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.commerce_checkout_resume_drafts FROM PUBLIC/);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.commerce_order_draft_receipts FROM PUBLIC/);
    expect(sql).not.toMatch(/^\s*GRANT\s+/im);
    expect(sql).not.toMatch(/SECURITY\s+DEFINER/i);
  });
});
