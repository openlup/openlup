import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PATH = "db/platform/migrations/20260817120000_prelaunch_acquisition_projection.sql";
const migration = readFileSync(PATH, "utf8");

describe("portable prelaunch acquisition projection", () => {
  it("adds one bounded detail routine over the existing tester acquisition case", () => {
    expect(migration).toContain("CREATE FUNCTION public.acquisition_case_operator_get_v1");
    expect(migration).toContain("c.source_kind = 'tester_application'");
    expect(migration).toContain("acquisition_private.case_projection(v_case_id)");
    expect(migration).toContain("'outcome', 'not_found'");
    expect(migration).toContain("'outcome', 'found'");
  });

  it("exposes no private table or public/browser privilege", () => {
    const executable = migration.replace(/^--.*$/gm, "");
    expect(executable).not.toMatch(/CREATE\s+(TABLE|ROLE|SCHEMA)/i);
    expect(executable).not.toMatch(/\b(testers|waitlist|feedback|clients|normalized_email|normalized_phone)\b/i);
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.acquisition_case_operator_get_v1(uuid, text)");
    expect(migration).toContain("FROM PUBLIC, anon, authenticated");
    expect(migration).toContain("TO platform_acquisition_runtime");
    expect((migration.match(/^\s*GRANT EXECUTE ON FUNCTION/gm) ?? [])).toHaveLength(1);
  });
});
