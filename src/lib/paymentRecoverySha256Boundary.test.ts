import { describe, expect, it } from "vitest";
import { managedFunction } from "../test/managedSchema";
const recoveryFunctions = ["subscription_record_payment_recovery_request", "subscription_resume_from_dunning_with_cycle_order"];
const migration = recoveryFunctions.map(managedFunction).join("\n");
// Executable SQL only — strip full-line `--` comments so the header prose (which
// quotes the old `token_hash IN (... md5(...))` form for context) can't trip the
// "no MD5 lookup" assertions below.
const sql = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("payment recovery SHA-256 cleanup (drop MD5 fallback) boundary", () => {
  it("isolates the two currently executed lookup RPCs", () => {
    for (const fn of [
      "subscription_record_payment_recovery_request",
      "subscription_resume_from_dunning_with_cycle_order",
    ]) {
      expect(sql).toContain(`CREATE FUNCTION public.${fn}`);
    }
    expect(sql).not.toContain("CREATE FUNCTION public.subscription_handle_payment_failure_dunning");
  });

  it("narrows BOTH lookups to a single SHA-256 hash (no dual-hash, no MD5)", () => {
    for (const fn of recoveryFunctions) {
      expect(managedFunction(fn)).toMatch(/WHERE (?:token\.)?token_hash = encode\(sha256\(convert_to\(p_recovery_token, 'UTF8'\)\), 'hex'\)/);
    }
    expect(sql).not.toContain("token_hash IN (");
    expect(sql).not.toContain("md5(p_recovery_token))");
    expect(sql).not.toContain(":= md5(v_token)");
  });

  it("leaves the request-fingerprint md5() idempotency hashes untouched", () => {
    // One per lookup RPC — these are idempotency fingerprints, not the token hash.
    expect(sql.split("md5(p_recovery_token) || '|' ||").length - 1).toBe(2);
  });

  it("keeps the recovery RPCs service-role-only", () => {
    for (const fn of recoveryFunctions) {
      const source = managedFunction(fn);
      expect(source).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}[^;]+FROM PUBLIC;`));
      expect(source).toMatch(new RegExp(`GRANT ALL ON FUNCTION public\\.${fn}[^;]+TO service_role;`));
      expect(source).not.toMatch(/GRANT [^;]+TO (?:PUBLIC|anon|authenticated)/);
    }
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
