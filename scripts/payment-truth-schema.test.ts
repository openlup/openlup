import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MIGRATION = "db/platform/migrations/20260815150000_payment_truth_reconciliation.sql";
const sql = readFileSync(MIGRATION, "utf8");
const executable = sql.replace(/^--.*$/gm, "");

describe("payment truth public forward", () => {
  it("delegates terminal ownership to the three existing rails", () => {
    expect(sql).toContain("public.commerce_record_settlement(");
    expect(sql).toContain("public.dunning_lifecycle_open_case(");
    expect(sql).toContain("public.accounting_document_request_from_paid_order(");
    expect(sql).toContain("public.dunning_lifecycle_record_recovery(");
  });

  it("contains event/reconciliation evidence without a provider machine or retry ladder", () => {
    expect(sql).toContain("CREATE TABLE public.payment_truth_events");
    expect(sql).toContain("CREATE TABLE public.payment_truth_reconciliation_evidence");
    expect(sql).toContain("payment_truth_event_fingerprint_conflict");
    expect(executable).not.toMatch(/stripe|tpay|provider_attempt|mandate|signature_verified/i);
    expect(executable).not.toMatch(/next_retry_at\s*:=|retry_interval|retry_ladder/i);
  });

  it("treats currency as data", () => {
    expect(sql).toContain("currency_code ~ '^[A-Z]{3}$'");
    expect(sql).not.toMatch(/currency_code\s*=\s*'PLN'|DEFAULT\s+'PLN'/);
  });
});
