import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260606190000_hidden_customer_address_profiles.sql",
  "utf8",
);

describe("hidden customer address profile boundary", () => {
  it("stores structured address/orderer facts without provider payloads", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS delivery_notes text");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS courier_instructions text");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.customer_orderer_profiles");
    expect(migration).toContain("CHECK (recipient_name IS NULL OR char_length(recipient_name) <= 200)");
    expect(migration).toContain("CHECK (contact_phone IS NULL OR char_length(contact_phone) <= 64)");
    expect(migration).toContain("CHECK (delivery_notes IS NULL OR char_length(delivery_notes) <= 500)");
    expect(migration).toContain(
      "CHECK (courier_instructions IS NULL OR char_length(courier_instructions) <= 500)",
    );
    expect(migration).not.toContain("provider_payload");
    expect(migration).not.toContain("psp");
    expect(migration).not.toContain("dhl_payload");
  });

  it("keeps orderer profiles owner-scoped and hidden from anon", () => {
    expect(migration).toContain("ALTER TABLE public.customer_orderer_profiles ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("REVOKE ALL ON TABLE public.customer_orderer_profiles FROM anon");
    expect(migration).toContain("customer_select_own_orderer_profiles");
    expect(migration).toContain("clients.auth_user_id = auth.uid()");
    expect(migration).toContain("GRANT SELECT ON TABLE public.customer_orderer_profiles TO authenticated");
  });
});

describe("hidden customer address anon hardening", () => {
  const hardening = readFileSync(
    "supabase/migrations/20260606191000_hidden_customer_addresses_revoke_anon.sql",
    "utf8",
  );

  it("removes stale anon table privileges from physical addresses", () => {
    expect(hardening).toContain("REVOKE ALL ON TABLE public.addresses FROM anon");
    expect(hardening).toContain("GRANT ALL ON TABLE public.addresses TO authenticated");
    expect(hardening).not.toContain("GRANT ALL ON TABLE public.addresses TO anon");
  });
});
