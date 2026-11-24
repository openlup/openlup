import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { nativeStoreFunctionDefinitions, sqlStatements } from "./reviewed-platform-forward.ts";

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

// Follow the current portable catalogue, so a later replacement also changes this witness.
describe("provider-recorded renewal retry timing", () => {
  it("delegates to subscription_retry_schedule_read with the SQL default of [24,72,168] hours", () => {
    const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
    const statements = [manifest.baseline, ...manifest.forward].flatMap(({ file }: { file: string }) =>
      sqlStatements(readFileSync(file, "utf8"), true));
    const definition = (signature: string) => statements.filter(statement =>
      /^CREATE (?:OR REPLACE )?FUNCTION /u.test(statement)
      && nativeStoreFunctionDefinitions(Buffer.from(statement), [signature], true).has(signature)).at(-1);
    const provider11 = definition("public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text)");
    expect(provider11).toMatch(/RETURN public\.payment_provider_result_apply\([\s\S]*?,NULL::jsonb\);/u);
    const provider12 = definition("public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text,jsonb)");
    expect(provider12).toMatch(/retry_result:=public\.subscription_retry_apply_failure\(renewal\.id,p_idempotency_key\|\|':truth',\s*jsonb_build_object\([\s\S]*?'firstRecordedAt',COALESCE\(e\.created_at,a\.updated_at\)\),\s*COALESCE\(p_cadence,\s*public\.subscription_retry_schedule_read\(\)\)\);/u);
    const failure = definition("public.subscription_retry_apply_failure(uuid,text,jsonb)");
    expect(failure).toMatch(/RETURN public\.subscription_retry_apply_failure\(p_operation_id,p_key,p_input,public\.subscription_retry_schedule_read\(\)\);/u);
    const reader = definition("public.subscription_retry_schedule_read()");
    expect(reader).toMatch(/RETURN '\{"backoffHours":\[24,72,168\]\}'::jsonb;/u);
  });
});
