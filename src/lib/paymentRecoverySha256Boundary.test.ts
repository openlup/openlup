import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Post-transition end state: the MD5 read fallback has been dropped, so the
// recovery-token lookups are SHA-256 only. This guards the cleanup migration
// that supersedes the dual-hash transition in 20260612210000.
const migration = read("supabase/migrations/20260627100000_payment_recovery_drop_md5_fallback.sql");
// Executable SQL only — strip full-line `--` comments so the header prose (which
// quotes the old `token_hash IN (... md5(...))` form for context) can't trip the
// "no MD5 lookup" assertions below.
const sql = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const SHA256_LOOKUP =
  "WHERE token_hash = encode(sha256(convert_to(p_recovery_token, 'UTF8')), 'hex')";

describe("payment recovery SHA-256 cleanup (drop MD5 fallback) boundary", () => {
  it("replaces only the two lookup RPCs (the SHA-256 write fn is untouched)", () => {
    for (const fn of [
      "subscription_record_payment_recovery_request",
      "subscription_resume_from_dunning_with_cycle_order",
    ]) {
      expect(sql).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
    }
    expect(sql).not.toContain("CREATE OR REPLACE FUNCTION public.subscription_handle_payment_failure_dunning");
  });

  it("narrows BOTH lookups to a single SHA-256 hash (no dual-hash, no MD5)", () => {
    expect(sql.split(SHA256_LOOKUP).length - 1).toBe(2);
    expect(sql).not.toContain("token_hash IN (");
    expect(sql).not.toContain("md5(p_recovery_token))");
    expect(sql).not.toContain(":= md5(v_token)");
  });

  it("leaves the request-fingerprint md5() idempotency hashes untouched", () => {
    // One per lookup RPC — these are idempotency fingerprints, not the token hash.
    expect(sql.split("md5(p_recovery_token) || '|' ||").length - 1).toBe(2);
  });

  it("keeps the recovery RPCs service-role-only", () => {
    for (const fn of [
      "subscription_record_payment_recovery_request",
      "subscription_resume_from_dunning_with_cycle_order",
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn}`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}`);
    }
    expect(sql).toContain("FROM PUBLIC, anon, authenticated");
    expect(sql).toContain("TO service_role");
  });

  it("has no explicit transaction control and no schema or provider side effects", () => {
    // The migration runner wraps each file in a transaction
    // (.squawk.toml assume_in_transaction = true), so no explicit BEGIN/COMMIT.
    expect(sql).not.toContain("BEGIN;");
    expect(sql).not.toContain("COMMIT;");
    for (const forbidden of ["CREATE TABLE", "ALTER TABLE", "DROP TABLE", "stripe", "tpay", "fakturownia"]) {
      expect(sql).not.toContain(forbidden);
    }
  });
});

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}
