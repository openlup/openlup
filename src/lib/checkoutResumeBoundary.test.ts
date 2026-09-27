import { describe, expect, it } from "vitest";
import { allMigrations } from "../test/effectiveMigration";
import { declaredTableGrants, managedFunction, managedTable } from "../test/managedSchema";
const migration = managedTable("commerce_checkout_resume_drafts");
const cleanupMigration = managedFunction("commerce_checkout_resume_cleanup_expired");
const indexes = allMigrations().flatMap(({ content }) => [...content.matchAll(/^CREATE (?:UNIQUE )?INDEX [^;]+ ON public\.commerce_checkout_resume_drafts[^;]+;/gm)].map(([statement]) => statement)).join("\n");

describe("hidden checkout resume boundary", () => {
  it("creates a server-side draft table with hashed URL tokens only", () => {
    expect(migration).toContain(
      "CREATE TABLE public.commerce_checkout_resume_drafts",
    );
    expect(migration).toContain("token_hash text NOT NULL");
    expect(migration).toContain("UNIQUE (token_hash)");
    expect(migration).toContain("idempotency_key_hash text");
    expect(migration).toContain("token_hash ~ '^[0-9a-f]{64}$'::text");
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

  it("keeps service-role RLS and denies browser table grants", () => {
    expect(migration).toContain("ALTER TABLE public.commerce_checkout_resume_drafts ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("CREATE POLICY service_role_all_commerce_checkout_resume_drafts");
    expect(declaredTableGrants(migration, "anon")).toEqual([]);
    expect(declaredTableGrants(migration, "authenticated")).toEqual([]);
    expect(declaredTableGrants(migration, "service_role")).toEqual(["ALL"]);
  });

  it("has expiry and active lookup indexes for cleanup/read paths", () => {
    expect(indexes).toContain("idx_commerce_checkout_resume_idempotency_active");
    expect(indexes).toContain("idx_commerce_checkout_resume_expires_active");
    expect(indexes).toContain("revoked_at IS NULL");
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
    expect(cleanupMigration).toMatch(/REVOKE ALL ON FUNCTION public\.commerce_checkout_resume_cleanup_expired[^;]+FROM PUBLIC;/);
    expect(cleanupMigration).toMatch(/GRANT ALL ON FUNCTION public\.commerce_checkout_resume_cleanup_expired[^;]+TO service_role;/);
    expect(cleanupMigration).not.toMatch(/GRANT [^;]+TO (?:PUBLIC|anon|authenticated)/);
    expect(cleanupMigration).not.toMatch(/cron\.schedule|pg_cron|CREATE\s+TRIGGER/i);
    expect(cleanupMigration).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.commerce_checkout_resume_cleanup_expired\(timestamptz,\s*integer\)\s+TO\s+(anon|authenticated)/i,
    );
  });
});
