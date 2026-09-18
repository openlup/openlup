import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260606202000_hidden_checkout_resume_drafts.sql",
  "utf8",
);
const cleanupMigration = readFileSync(
  "supabase/migrations/20260606203000_hidden_checkout_resume_cleanup.sql",
  "utf8",
);

describe("hidden checkout resume boundary", () => {
  it("creates a server-side draft table with hashed URL tokens only", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS public.commerce_checkout_resume_drafts",
    );
    expect(migration).toContain("token_hash text NOT NULL UNIQUE");
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

    expect(migration).toContain("jsonb_typeof(draft_state) = 'object'");
    expect(migration).toContain("commerce_checkout_resume_redacted_fields_known");
  });

  it("is hidden behind service-role RLS and denies anon/authenticated table grants", () => {
    expect(migration).toContain(
      "ALTER TABLE public.commerce_checkout_resume_drafts ENABLE ROW LEVEL SECURITY",
    );
    expect(migration).toContain(
      'CREATE POLICY "service_role_all_commerce_checkout_resume_drafts"',
    );
    expect(migration).toContain(
      "REVOKE ALL ON TABLE public.commerce_checkout_resume_drafts FROM anon",
    );
    expect(migration).toContain(
      "REVOKE ALL ON TABLE public.commerce_checkout_resume_drafts FROM authenticated",
    );
    expect(migration).toContain(
      "GRANT ALL ON TABLE public.commerce_checkout_resume_drafts TO service_role",
    );
    expect(migration).not.toContain(
      "GRANT ALL ON TABLE public.commerce_checkout_resume_drafts TO authenticated",
    );
  });

  it("has expiry and active lookup indexes for cleanup/read paths", () => {
    expect(migration).toContain("idx_commerce_checkout_resume_idempotency_active");
    expect(migration).toContain("idx_commerce_checkout_resume_expires_active");
    expect(migration).toContain("WHERE revoked_at IS NULL");
  });

  it("keeps stale draft cleanup manual and service-role only", () => {
    expect(cleanupMigration).toContain(
      "CREATE OR REPLACE FUNCTION public.commerce_checkout_resume_cleanup_expired",
    );
    expect(cleanupMigration).toContain("SECURITY DEFINER");
    expect(cleanupMigration).toContain("SET search_path = public");
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
    expect(cleanupMigration).toContain(
      "REVOKE ALL ON FUNCTION public.commerce_checkout_resume_cleanup_expired(timestamptz, integer) FROM anon",
    );
    expect(cleanupMigration).toContain(
      "REVOKE ALL ON FUNCTION public.commerce_checkout_resume_cleanup_expired(timestamptz, integer) FROM authenticated",
    );
    expect(cleanupMigration).toContain(
      "GRANT EXECUTE ON FUNCTION public.commerce_checkout_resume_cleanup_expired(timestamptz, integer) TO service_role",
    );
    expect(cleanupMigration).not.toMatch(/cron\.schedule|pg_cron|CREATE\s+TRIGGER/i);
    expect(cleanupMigration).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.commerce_checkout_resume_cleanup_expired\(timestamptz,\s*integer\)\s+TO\s+(anon|authenticated)/i,
    );
  });
});
