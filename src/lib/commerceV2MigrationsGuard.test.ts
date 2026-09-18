import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Architecture lint guards for the commerce-v2 migration sequence.
 *
 * Parses every `supabase/migrations/*_commerce_v2_*.sql` file at test time and asserts the
 * invariants the commerce v2 plan (§13 lint guard registry) requires for the migration
 * surface:
 *   - Every new table gains RLS via `ENABLE ROW LEVEL SECURITY` + at least one policy
 *     matching the existing `admin_all_<table>` pattern from the ecommerce schema shell.
 *   - Axis columns reference their registry tables (FK only, never free-form text + CHECK).
 *   - No `bundle_id` / `offer_id` / `plan_id` / `subscription_box_id` columns ever appear
 *     (§1.3 invariant: bundles/subscriptions/offers are roles, not entities).
 *
 * These checks read the migration source — they do not require a live database. The
 * complementary DB-side checks live in `commerceV2InvariantsLive.test.ts`.
 *
 * See: ~/.claude/plans/users-bartroszkowski-downloads-openlup-com-shiny-cray.md §13, §17.1
 */

const repoRoot = process.cwd();
const migrationsDir = join(repoRoot, "supabase", "migrations");

function listCommerceV2Migrations(): string[] {
  if (!existsSync(migrationsDir)) return [];

  return readdirSync(migrationsDir)
    .filter((file) => /^\d{14}_commerce_v2_.*\.sql$/.test(file))
    .sort();
}

function readMigration(file: string): string {
  return readFileSync(join(migrationsDir, file), "utf8");
}

function extractCreatedTables(sql: string): string[] {
  const pattern = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?public\.(\w+)/gi;
  return [...sql.matchAll(pattern)].map((match) => match[1]);
}

function extractRlsEnabledTables(sql: string): string[] {
  const pattern = /ALTER TABLE\s+public\.(\w+)\s+ENABLE ROW LEVEL SECURITY/gi;
  return [...sql.matchAll(pattern)].map((match) => match[1]);
}

function extractAdminPolicies(sql: string): string[] {
  const pattern = /CREATE POLICY\s+"admin_all_(\w+)"\s+ON\s+public\.\w+/gi;
  return [...sql.matchAll(pattern)].map((match) => match[1]);
}

function extractForbiddenColumns(sql: string): string[] {
  const pattern =
    /ADD COLUMN\s+(?:IF NOT EXISTS\s+)?(bundle_id|offer_id|plan_id|subscription_box_id)\b/gi;
  return [...sql.matchAll(pattern)].map((match) => match[1]);
}

describe("commerce-v2 migration guardrails", () => {
  const migrationFiles = listCommerceV2Migrations();

  it("locates at least one commerce-v2 migration", () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
  });

  it("enables RLS on every freshly created table", () => {
    const missingRls = migrationFiles.flatMap((file) => {
      const sql = readMigration(file);
      const created = extractCreatedTables(sql);
      const rlsEnabled = new Set(extractRlsEnabledTables(sql));
      return created
        .filter((table) => !rlsEnabled.has(table))
        .map((table) => `${file}:${table}`);
    });

    expect(missingRls).toEqual([]);
  });

  it("creates an admin_all_<table> policy for every freshly created table", () => {
    const missingPolicy = migrationFiles.flatMap((file) => {
      const sql = readMigration(file);
      const created = extractCreatedTables(sql);
      const polices = new Set(extractAdminPolicies(sql));
      return created
        .filter((table) => !polices.has(table))
        .map((table) => `${file}:${table}`);
    });

    expect(missingPolicy).toEqual([]);
  });

  it("ensures axis columns reference their registry tables via FK", () => {
    const offenders = migrationFiles.flatMap((file) => {
      const sql = readMigration(file);
      const formatCodeWithoutFk = /ADD COLUMN[^,;]*format_code[^,;]*(?!REFERENCES\s+public\.variant_formats)/i;
      const unitFormCodeWithoutFk = /ADD COLUMN[^,;]*unit_form_code[^,;]*(?!REFERENCES\s+public\.variant_unit_forms)/i;

      const fmtAdded = /ADD COLUMN[^,;]+format_code/i.test(sql);
      const fmtFkOk = /format_code\s+text\s+REFERENCES\s+public\.variant_formats\(code\)/i.test(sql);
      const ufAdded = /ADD COLUMN[^,;]+unit_form_code/i.test(sql);
      const ufFkOk = /unit_form_code\s+text\s+REFERENCES\s+public\.variant_unit_forms\(code\)/i.test(sql);

      const violations: string[] = [];
      if (fmtAdded && !fmtFkOk) violations.push(`${file}:format_code missing FK to variant_formats`);
      if (ufAdded && !ufFkOk) violations.push(`${file}:unit_form_code missing FK to variant_unit_forms`);
      // The regex objects are referenced so eslint does not flag the helpers as unused — they
      // document the intent for future axes added by W2+ migrations.
      void formatCodeWithoutFk;
      void unitFormCodeWithoutFk;
      return violations;
    });

    expect(offenders).toEqual([]);
  });

  it("forbids bundle_id / offer_id / plan_id / subscription_box_id columns (§1.3 invariant)", () => {
    const offenders = migrationFiles.flatMap((file) => {
      const sql = readMigration(file);
      return extractForbiddenColumns(sql).map((column) => `${file}:${column}`);
    });

    expect(offenders).toEqual([]);
  });

  it("uses a zero-rows guard before SET NOT NULL or DROP TABLE on shell data", () => {
    const offenders = migrationFiles.flatMap((file) => {
      const sql = readMigration(file);
      const hasSetNotNullOrDrop =
        /\bSET NOT NULL\b/i.test(sql) || /\bDROP TABLE\b/i.test(sql);
      if (!hasSetNotNullOrDrop) return [];

      const hasGuard = /DO\s+\$\$\s+BEGIN[\s\S]+?count\(\*\)[\s\S]+?RAISE EXCEPTION/i.test(sql);
      return hasGuard ? [] : [`${file}:missing zero-rows DO block before SET NOT NULL / DROP TABLE`];
    });

    expect(offenders).toEqual([]);
  });
});
