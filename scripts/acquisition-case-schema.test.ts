import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PATH = "db/platform/migrations/20260816140000_acquisition_case_foundation.sql";
const migration = readFileSync(PATH, "utf8");
const rpcCatalog = JSON.parse(readFileSync("config/supabase-rpc-catalog.json", "utf8")) as {
  groups: Array<{ name: string; match: string[]; securityDefinerExpected: boolean; migrationRoot?: string }>;
};

describe("portable acquisition-case foundation", () => {
  it("owns only the bounded private model and no raw address directory", () => {
    expect(migration).toContain("CREATE SCHEMA acquisition_private AUTHORIZATION platform_acquisition_owner");
    for (const table of [
      "installation_key", "address_references", "rate_limit_windows", "cases",
      "contacts", "commands", "audit",
    ]) expect(migration).toContain(`CREATE TABLE acquisition_private.${table}`);
    const executable = migration.replace(/^--.*$/gm, "");
    expect(executable).not.toMatch(/\b(street|city|postcode|postal_code|pet_|waitlist|newsletter|provider_payload)\b/i);
    expect(migration).toContain("address_reference_id = CASE WHEN p_target_lifecycle = 'withdrawn' THEN NULL");
    expect(migration).toContain("normalized_email = NULL");
    expect(migration).toContain("normalized_phone = NULL");
  });

  it("creates uncapturable NOLOGIN roles and grants four acquisition routines only", () => {
    expect(migration).toContain("acquisition_role_bootstrap_requires_superuser");
    expect(migration).toContain("rolname = current_user AND rolsuper IS true");
    for (const role of ["platform_acquisition_owner", "platform_acquisition_runtime"]) {
      expect(migration).toContain(`('${role}'::text)`);
    }
    expect(migration).toContain("NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    expect(migration).toContain("RAISE EXCEPTION 'acquisition_role_preexisting:%'");
    expect(migration).toContain("GRANT platform_acquisition_runtime TO CURRENT_USER WITH INHERIT FALSE, SET TRUE");
    expect(migration).toContain("acquisition_owner_membership_invalid");
    expect(migration).toContain("acquisition_runtime_parent_membership_invalid");
    expect(migration).toContain("acquisition_runtime_membership_invalid");
    expect(migration).toContain("admin_option IS false AND inherit_option IS false AND set_option IS true");
    expect(migration).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA acquisition_private");
    expect(migration).toContain("REVOKE ALL ON ALL SEQUENCES IN SCHEMA acquisition_private");
    expect(migration).toContain("REVOKE ALL ON SCHEMA acquisition_private FROM PUBLIC, anon, authenticated");
    expect(migration).toContain("GRANT USAGE ON SCHEMA public TO platform_acquisition_runtime");
    expect(migration).toContain("REVOKE CREATE ON SCHEMA public FROM platform_acquisition_runtime");

    const signatures = [
      "acquisition_case_submit_v1(\n  text, text, text, text, boolean, text, text, text, text,\n  text, text, text, text, timestamptz\n)",
      "acquisition_case_operator_list_v1(uuid, timestamptz, uuid, integer)",
      "acquisition_case_transition_v1(uuid, text, bigint, text, text, text, timestamptz)",
      "acquisition_case_active_count_v1()",
    ];
    for (const signature of signatures) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature}`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${signature}`);
    }
    expect((migration.match(/GRANT EXECUTE ON FUNCTION public\.acquisition_case_/g) ?? [])).toHaveLength(4);
    expect(migration).toContain("unrelated public-schema function privileges\n-- remain unchanged");
  });

  it("uses owner-only keyed fingerprints and never persists raw reasons or requester keys", () => {
    expect(migration).toContain("octet_length(key_bytes) = 32");
    expect(body("acquisition_private.keyed_digest")).toContain("sha256(k.key_bytes");
    expect(body("acquisition_private.keyed_digest")).toContain("|| k.key_bytes");
    expect(body("public.acquisition_case_submit_v1")).toContain("'tester-application-requester-limit'");
    expect(body("public.acquisition_case_submit_v1")).toContain("'tester-application-email-limit'");
    expect(body("public.acquisition_case_transition_v1")).toContain("'reason', p_reason");
    const tableDdl = migration.slice(0, migration.indexOf("CREATE FUNCTION acquisition_private.keyed_digest"));
    expect(tableDdl).not.toContain("requester_key");
    expect(tableDdl).not.toContain("reason text");
    expect(migration).not.toContain("SECURITY DEFINER\nSET search_path = public");
  });

  it("orders validation, replay, address admission, limiter and dedupe before mutation", () => {
    const submit = body("public.acquisition_case_submit_v1");
    const validation = submit.indexOf("RAISE EXCEPTION 'acquisition_case_invalid'");
    const replay = submit.indexOf("WHERE scope = 'submit'");
    const address = submit.indexOf("FROM acquisition_private.address_references");
    const requesterLimit = submit.indexOf("VALUES ('requester'");
    const emailLimit = submit.indexOf("VALUES ('email'");
    const dedupe = submit.indexOf("'acquisition-dedupe:'");
    const caseInsert = submit.indexOf("INSERT INTO acquisition_private.cases");
    expect(validation).toBeLessThan(replay);
    expect(replay).toBeLessThan(address);
    expect(address).toBeLessThan(requesterLimit);
    expect(requesterLimit).toBeLessThan(emailLimit);
    expect(emailLimit).toBeLessThan(dedupe);
    expect(dedupe).toBeLessThan(caseInsert);
    expect(submit).toContain("limiter.window_started_at <= p_now - interval '60 minutes'");
    expect(submit).toContain("v_requester_attempts > 5");
    expect(submit).toContain("v_email_attempts > 3");
    expect(submit).toContain("RETURN jsonb_build_object('outcome', 'rate_limited'");
  });

  it("fences lifecycle, replay and redaction with one typed append-only audit", () => {
    const transition = body("public.acquisition_case_transition_v1");
    expect(transition.indexOf("WHERE scope = 'transition'")).toBeLessThan(transition.indexOf("FOR UPDATE"));
    expect(transition).toContain("v_case.state_version <> p_expected_version");
    expect(transition).toContain("v_case.lifecycle = 'submitted'");
    expect(transition).toContain("p_target_lifecycle IN ('active', 'rejected', 'withdrawn')");
    expect(transition).toContain("v_case.lifecycle IN ('active', 'rejected')");
    expect(transition).toContain("normalized_email = NULL");
    expect(transition).toContain("INSERT INTO acquisition_private.audit");
    expect(transition).toContain("INSERT INTO acquisition_private.commands");
    expect(migration).toContain("result_projection jsonb NOT NULL");
    expect(transition).toContain("'acquisitionCase', v_existing_command.result_projection");
    expect(transition).toContain("acquisition_private.case_projection(v_case.id), p_now");
    expect(body("public.acquisition_case_active_count_v1")).toContain("c.lifecycle IN ('approved', 'active')");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON acquisition_private.commands");
    expect(migration).toContain("BEFORE TRUNCATE ON acquisition_private.commands");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON acquisition_private.audit");
    expect(migration).toContain("BEFORE TRUNCATE ON acquisition_private.audit");
  });

  it("returns the strict neutral allowlist and bounded keyset cursor", () => {
    const projection = body("acquisition_private.case_projection");
    for (const key of [
      "contractVersion", "caseRef", "contactRef", "sourceKind", "consent",
      "addressReference", "state", "version", "createdAt", "updatedAt",
    ]) expect(projection).toContain(`'${key}'`);
    expect(projection).not.toContain("normalized_email");
    expect(projection).not.toContain("normalized_phone");
    expect(projection).not.toContain("dedupe_fingerprint");
    const list = body("public.acquisition_case_operator_list_v1");
    expect(list).toContain("p_limit NOT BETWEEN 1 AND 100");
    expect(list).toContain("(c.created_at, c.id) < (p_after_created_at, p_after_id)");
    expect(list).toContain("ORDER BY c.created_at DESC, c.id DESC");
    expect(list).toContain("LIMIT p_limit + 1");
  });

  it("is exact in the RPC catalog", () => {
    const group = rpcCatalog.groups.find(({ name }) => name === "acquisition-case-platform-rail");
    expect(group).toMatchObject({
      match: ["^acquisition_case_"],
      securityDefinerExpected: true,
      migrationRoot: "db/platform/migrations",
    });
  });
});

function body(name: string): string {
  const start = migration.indexOf(`CREATE FUNCTION ${name}`);
  const next = migration.indexOf("\nCREATE FUNCTION ", start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  return migration.slice(start, next === -1 ? migration.length : next);
}
