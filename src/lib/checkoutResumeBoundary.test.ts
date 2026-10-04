import { effectiveFunctionBody } from "../test/effectiveMigration";
import { currentTableStatements, explicitTablePrivileges, explicitFunctionExecuteRoles } from "../test/historicalBoundarySchema";
import { describe, expect, it } from "vitest";

const migration = currentTableStatements("commerce_checkout_resume_drafts");
const cleanupMigration = effectiveFunctionBody("commerce_checkout_resume_cleanup_expired");

describe("hidden checkout resume boundary", () => {
  it("creates a server-side draft table with hashed URL tokens only", () => {
    expect(migration).toContain(
      "CREATE TABLE public.commerce_checkout_resume_drafts",
    );
    expect(migration).toContain("token_hash text NOT NULL");
    expect(migration).toContain("idempotency_key_hash text");
    expect(migration).toContain("token_hash ~ '^[0-9a-f]{64}$'");
    expect(migration).not.toMatch(/\bresume_token\s+text\b/);
    expect(migration).not.toMatch(/\braw_token\s+text\b/);
  });

  it("keeps resume state sanitized and explicitly rejects common top-level PII", () => {
    for (const forbidden of [
      "email",
      "phone",
      "street",
      "postalCode",
      "shippingAddress",
      "billingAddress",
      "deliveryNotes",
      "courierInstructions",
      "providerPayload",
      "blik",
      "card",
      "rawFormPayload",
    ]) {
      expect(migration).toContain(`'${forbidden}'`);
    }

    expect(migration).toContain("jsonb_typeof(draft_state) = 'object'::text");
    expect(migration).toContain("commerce_checkout_resume_redacted_fields_known");
  });

  it("is hidden behind service-role RLS and denies anon/authenticated table grants", () => {
    expect(migration).toContain(
      "ALTER TABLE public.commerce_checkout_resume_drafts ENABLE ROW LEVEL SECURITY",
    );
    expect(migration).toContain("UNIQUE (token_hash)");
    const roles = explicitTablePrivileges("commerce_checkout_resume_drafts");
    for (const role of ["PUBLIC", "anon", "authenticated"]) expect(roles.get(role)?.size ?? 0).toBe(0);
    expect(roles.get("service_role")?.has("INSERT")).toBe(true);
  });

  it("has expiry and active lookup indexes for cleanup/read paths", () => {
    expect(migration).toContain("idx_commerce_checkout_resume_idempotency_active");
    expect(migration).toContain("idx_commerce_checkout_resume_expires_active");
    expect(migration).toContain("WHERE (revoked_at IS NULL)");
  });

  it("keeps stale draft cleanup manual and service-role only", () => {
    expect(cleanupMigration).toContain(
      "CREATE FUNCTION public.commerce_checkout_resume_cleanup_expired",
    );
    expect(cleanupMigration).toContain("SECURITY DEFINER");
    expect(cleanupMigration).toContain("SET search_path TO 'public'");
    expect(cleanupMigration).toContain(
      "DELETE FROM public.commerce_checkout_resume_drafts",
    );
    expect(cleanupMigration).toContain("v_now timestamptz := COALESCE(p_now, now())");
    expect(cleanupMigration).toContain("expires_at < v_now");
    expect(cleanupMigration).toContain(
      "revoked_at IS NOT NULL AND revoked_at < v_now",
    );
    expect(cleanupMigration).toContain(
      "LEAST(GREATEST(COALESCE(p_limit, 500), 1), 1000)",
    );
    for (const roles of explicitFunctionExecuteRoles("commerce_checkout_resume_cleanup_expired").values()) {
      expect(roles.has("service_role")).toBe(true);
      for (const role of ["PUBLIC", "anon", "authenticated"]) expect(roles.has(role)).toBe(false);
    }
    expect(cleanupMigration).not.toMatch(/cron\.schedule|pg_cron|CREATE\s+TRIGGER/i);
    expect(cleanupMigration).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.commerce_checkout_resume_cleanup_expired\(timestamptz,\s*integer\)\s+TO\s+(anon|authenticated)/i,
    );
  });
});
