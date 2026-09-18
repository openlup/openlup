import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PATH = "db/platform/migrations/20260817110000_partner_acquisition_lifecycle.sql";
const VALIDATE_PATH = "db/platform/migrations/20260817110100_partner_acquisition_lifecycle_validate.sql";
const LOCALE_PATH = "db/platform/migrations/20260817111000_partner_acquisition_locale_constraint.sql";
const LOCALE_VALIDATE_PATH = "db/platform/migrations/20260817111100_partner_acquisition_locale_constraint_validate.sql";
const migration = readFileSync(PATH, "utf8");
const validationMigration = readFileSync(VALIDATE_PATH, "utf8");
const localeMigration = readFileSync(LOCALE_PATH, "utf8");
const localeValidationMigration = readFileSync(LOCALE_VALIDATE_PATH, "utf8");
const rpcCatalog = JSON.parse(readFileSync("config/supabase-rpc-catalog.json", "utf8")) as {
  groups: Array<{ name: string; match: string[]; securityDefinerExpected: boolean; migrationRoot?: string }>;
};

describe("portable partner acquisition lifecycle", () => {
  it("extends the existing acquisition authority without provider or CRM schema", () => {
    expect(migration).toContain("ADD CONSTRAINT acquisition_case_source_check");
    expect(migration).toContain("source_kind IN ('tester_application', 'partner_inquiry')");
    expect(migration).toContain("CREATE TABLE acquisition_private.partner_details");
    expect(migration).toContain("partner_inquiry' AND address_reference_id IS NULL");
    const executable = migration.replace(/^--.*$/gm, "");
    expect(executable).not.toMatch(/\b(pipedrive|provider_payload|newsletter|customer_id|pet_id)\b/i);
    expect(executable).not.toMatch(/^\s*GRANT\s+.+\s+TO\s+(PUBLIC|anon|authenticated)\b/im);
  });

  it("validates and replays before limiter, dedupe and mutation", () => {
    const submit = body("public.partner_acquisition_submit_v1");
    const validation = submit.indexOf("RAISE EXCEPTION 'partner_acquisition_invalid'");
    const replay = submit.indexOf("WHERE scope = 'partner_submit'");
    const requesterLimit = submit.indexOf("VALUES ('requester'");
    const emailLimit = submit.indexOf("VALUES ('email'");
    const dedupe = submit.indexOf("'partner-dedupe:'");
    const insert = submit.indexOf("INSERT INTO acquisition_private.cases");
    expect(validation).toBeLessThan(replay);
    expect(replay).toBeLessThan(requesterLimit);
    expect(requesterLimit).toBeLessThan(emailLimit);
    expect(emailLimit).toBeLessThan(dedupe);
    expect(dedupe).toBeLessThan(insert);
    expect(submit).toContain("'partner-inquiry-requester-limit'");
    expect(submit).toContain("'partner-inquiry-email-limit'");
    expect(submit).toContain("'contact_conflict'");
  });

  it("fences the neutral pipeline with expected version and append-only evidence", () => {
    const transition = body("public.partner_acquisition_transition_v1");
    expect(transition.indexOf("WHERE scope = 'partner_transition'")).toBeLessThan(transition.indexOf("FOR UPDATE"));
    expect(transition).toContain("v_case.state_version <> p_expected_version");
    expect(transition).toContain("v_case.lifecycle = 'new'");
    expect(transition).toContain("INSERT INTO acquisition_private.audit");
    expect(transition).toContain("INSERT INTO acquisition_private.commands");
    expect(transition).toContain("v_existing_command.result_projection");
    const projection = body("acquisition_private.partner_case_projection");
    for (const key of [
      "contractVersion", "caseRef", "contactRef", "organization", "contact",
      "notes", "status", "version", "createdAt", "updatedAt",
    ]) expect(projection).toContain(`'${key}'`);
    expect(projection).not.toContain("dedupe_fingerprint");
  });

  it("grants only the three named routines to the existing runtime role", () => {
    const signatures = [
      "partner_acquisition_submit_v1(\n  text, text, text, text, text, text, text, text, text, text, text, timestamptz\n)",
      "partner_acquisition_operator_list_v1(uuid, timestamptz, uuid, integer)",
      "partner_acquisition_transition_v1(uuid, text, bigint, text, text, timestamptz)",
    ];
    for (const signature of signatures) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature}`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${signature}`);
    }
    expect((migration.match(/GRANT EXECUTE ON FUNCTION public\.partner_acquisition_/g) ?? [])).toHaveLength(3);
    expect(migration).toContain("REVOKE ALL ON acquisition_private.partner_details");
  });

  it("keeps tester locales narrow while admitting the partner neutral sentinel", () => {
    expect(localeMigration).toContain("source_kind = 'tester_application' AND locale IN ('en', 'pl')");
    expect(localeMigration).toContain("source_kind = 'partner_inquiry' AND locale = 'und'");
    expect(localeMigration).toContain("ADD CONSTRAINT acquisition_case_locale_check");
    expect(localeMigration).toContain("NOT VALID");
    expect(localeValidationMigration).toContain("VALIDATE CONSTRAINT acquisition_case_locale_check");
    expect(localeMigration).not.toMatch(/UPDATE\s+acquisition_private\.cases/i);
  });

  it("is exact in the constraint validation and RPC catalogs", () => {
    expect((migration.match(/NOT VALID/g) ?? [])).toHaveLength(8);
    expect((validationMigration.match(/VALIDATE CONSTRAINT/g) ?? [])).toHaveLength(8);
    expect(rpcCatalog.groups.find(({ name }) => name === "partner-acquisition-platform-rail"))
      .toMatchObject({ match: ["^partner_acquisition_"], securityDefinerExpected: true, migrationRoot: "db/platform/migrations" });
  });
});

function body(name: string): string {
  const start = migration.indexOf(`CREATE FUNCTION ${name}`);
  const next = migration.indexOf("\nCREATE FUNCTION ", start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  return migration.slice(start, next === -1 ? migration.length : next);
}
