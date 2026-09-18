import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260606150000_customer_auth_and_checkout_rate_limit_hardening.sql",
  "utf8",
);

describe("customer auth and checkout rate-limit hardening migration", () => {
  it("adds advisory locks and cleanup to checkout attempts", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.public_record_checkout_attempt");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("hashtextextended");
    expect(migration).toContain("DELETE FROM public.public_checkout_attempts");
    expect(migration).toContain("interval '24 hours'");
  });

  it("adds a service-role-only customer magic-link rate-limit ledger", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.customer_magic_link_attempts");
    expect(migration).toContain("public_record_customer_magic_link_attempt");
    expect(migration).toContain("ALTER TABLE public.customer_magic_link_attempts ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("REVOKE ALL ON TABLE public.customer_magic_link_attempts FROM anon");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.public_record_customer_magic_link_attempt");
  });
});
