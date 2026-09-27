import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260606183000_hidden_customer_payment_preferences.sql",
  "utf8",
);

describe("hidden customer payment preferences boundary", () => {
  it("stores only sanitized payment method families", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.customer_payment_preferences");
    expect(migration).toContain("method_kind text NOT NULL CHECK (method_kind IN ('blik', 'card', 'transfer'))");
    expect(migration).toContain("UNIQUE (client_id, scope)");
    expect(migration).not.toContain("metadata");
    expect(migration).not.toContain("provider_kind");
    expect(migration).not.toContain("payment_method_ref");
    expect(migration).not.toContain("provider_payment_method");
  });

  it("keeps customer preferences owner-scoped and hidden from anon", () => {
    expect(migration).toContain("ALTER TABLE public.customer_payment_preferences ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("REVOKE ALL ON TABLE public.customer_payment_preferences FROM anon");
    expect(migration).toContain("clients.auth_user_id = auth.uid()");
    expect(migration).toContain("GRANT SELECT, INSERT, UPDATE ON TABLE public.customer_payment_preferences TO authenticated");
  });
});
