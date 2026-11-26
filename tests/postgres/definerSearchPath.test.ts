import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import {
  acquisitionSearchPathManifest,
  appendedSettings,
  appendedSignatures,
  binding,
  catalogPinned,
  explicitTrustedList,
  installAccountMutations,
  installAtAcquisitionSearchPathBoundary,
  observe,
  pinnedFunctions,
  profiles,
  remainingSettings,
  remainingSignatures,
  rollBackPin,
  searchPathFailures,
  searchPathRemedy,
  settings,
  signatures,
  slot,
  splitSearchPath,
  withContainerSlot,
} from "./definerSearchPath.fixture.js";

const runInContainerSlot = withContainerSlot(2);

async function checkScratchCensus(owner: Pool) {
  const schema = '"Path, ""fixture"""';
  const fixtures = [
    ["no_setting", "", explicitTrustedList],
    ["empty_setting", "SET search_path = ''", explicitTrustedList],
    ["no_temp", "SET search_path = public", "public, pg_temp"],
    ["temp_first", "SET search_path = pg_temp, public", "public, pg_temp"],
    ["empty_element", "SET search_path = '', pg_temp", explicitTrustedList],
    ['"valid, ""pin"""', `SET search_path = ${schema}, PG_TEMP`, null],
  ] as const;
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    for (const [name, setting] of fixtures) {
      await client.query(`CREATE FUNCTION ${schema}.${name}() RETURNS integer LANGUAGE sql SECURITY DEFINER ${setting} AS 'SELECT 1'`);
    }
    const census = async () => (await pinnedFunctions(client)).filter(row => row.signature.startsWith(`${schema}.`));
    const rows = await census();
    expect(rows.map(row => row.signature).sort()).toEqual(fixtures.map(([name]) => `${schema}.${name}()`).sort());
    expect(rows.find(row => row.signature === `${schema}.empty_element()`)?.search_path).toBe('"", pg_temp');
    const failures = searchPathFailures(rows);
    expect(failures.sort()).toEqual(fixtures.flatMap(([name, , list]) => list === null ? []
      : [searchPathRemedy(`${schema}.${name}()`, list)]).sort());

    const unissuedSignature = `${schema}.no_temp()`;
    const unissued = failures.find(message => message.startsWith(`Function ${unissuedSignature} `));
    const setting = unissued?.match(/`(SET search_path = [^`]+)`/u)?.[1];
    expect(setting).toBe("SET search_path = public, pg_temp");
    await client.query(`CREATE OR REPLACE FUNCTION ${unissuedSignature} RETURNS integer LANGUAGE sql SECURITY DEFINER ${setting} AS 'SELECT 1'`);

    for (const failure of failures.filter(message => message !== unissued)) {
      const sql = failure.match(/`(ALTER FUNCTION [^`]+;)`/u)?.[1];
      expect(sql).toBeDefined();
      await client.query(sql!.replace(explicitTrustedList, catalogPinned));
    }
    const repaired = await census();
    expect(searchPathFailures(repaired)).toEqual([]);
    for (const [name, , list] of fixtures) {
      const expected = list === null ? `${schema}, pg_temp` : list === explicitTrustedList ? catalogPinned : list;
      expect(repaired.find(row => row.signature === `${schema}.${name}()`)?.search_path).toBe(expected);
    }
  } finally {
    try { await client.query("ROLLBACK"); }
    finally { client.release(); }
  }
  expect((await owner.query("SELECT pg_catalog.to_regnamespace($1) IS NULL AS absent", [schema])).rows).toEqual([{ absent: true }]);
}

it("keeps the acquisition pin fixture unchanged when a later forward is appended", () => {
  const current = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
  if (current?.schemaVersion !== 3) throw new Error("Expected the complete platform migration catalogue");
  const extended = structuredClone(current);
  const later = { file: "db/platform/migrations/20990101000000_later_settings.sql", sha256: "1".repeat(64) };
  for (const plan of [extended, extended.qualified, extended.qualifiedAdmin]) plan.forward.push(later);
  extended.objectInventorySha256 = "2".repeat(64);
  extended.qualified.objectInventorySha256.bootstrapMigrator.withRestore = extended.objectInventorySha256;
  extended.qualified.objectInventorySha256.separateMigrator.withRestore = extended.objectInventorySha256;
  extended.qualifiedAdmin.objectInventorySha256.installerManaged = extended.objectInventorySha256;
  extended.qualifiedAdmin.objectInventorySha256.operatorProvisioned = extended.objectInventorySha256;

  const before = acquisitionSearchPathManifest(extended, "before-pin");
  const through = acquisitionSearchPathManifest(extended, "through-pin");
  expect(before).toEqual(acquisitionSearchPathManifest(current, "before-pin"));
  expect(through).toEqual(acquisitionSearchPathManifest(current, "through-pin"));
  for (const [predecessor, installed] of [
    [before, through], [before.qualified, through.qualified], [before.qualifiedAdmin, through.qualifiedAdmin],
  ] as const) {
    expect(installed.forward.slice(predecessor.forward.length)).toEqual([{ file: slot.path, sha256: binding.sha256 }]);
  }
});

it("reports the same remedy for issued and unissued function definitions", () => {
  expect(searchPathFailures([{ signature: 'public."Unpinned"()', search_path: "pg_catalog, public" }])).toEqual([
    'Function public."Unpinned"() must pin pg_temp once, last. If its defining migration is unissued, set `SET search_path = pg_catalog, public, pg_temp` in that definition. If it is issued, add a reviewed settings-only forward with `ALTER FUNCTION public."Unpinned"() SET search_path = pg_catalog, public, pg_temp;`. Rerun `tests/postgres/definerSearchPath.test.ts`.',
  ]);
});

it("accepts a single normalized final pg_temp and preserves trusted identifier spelling in repairs", () => {
  const cases: [name: string, path: string | null, list: string | null][] = [
    ["no_setting", null, explicitTrustedList],
    ["empty_setting", "", explicitTrustedList],
    ["empty_element", '"", pg_temp', explicitTrustedList],
    ["bare_empty_element", "pg_catalog,, pg_temp", explicitTrustedList],
    ["temp_only", "pg_Temp_12", explicitTrustedList],
    ["temp_first", "PG_TEMP, public", "public, pg_temp"],
    ["temp_repeated", 'pg_temp, "pg_temp", "schema, ""name""", public', '"schema, ""name""", public, pg_temp'],
    ["temp_duplicated", '"pg_temp", pg_catalog, pg_temp', catalogPinned],
    ["temp_numbered", '"pg_temp_12", pg_catalog, pg_temp', catalogPinned],
    ["quoted_upper_last", 'pg_catalog, "PG_TEMP"', 'pg_catalog, "PG_TEMP", pg_temp'],
    ["quoted_case", '"PG_TEMP", "pg_temp_12A", pg_temp', '"PG_TEMP", pg_temp'],
    ["quoted_comma", '"schema, pg_temp, name", pg_temp', null],
    ["pinned", 'pg_catalog, "pg_temp"', null],
    ["unquoted_upper", "pg_catalog, PG_TEMP", null],
    ["pg_temp_only", "pg_temp", null],
    ["user_schema_pinned", '"$user", pg_temp', null],
    ["user_schema_only", '"$user"', explicitTrustedList],
    ["user_schema", '"$user", public', '"$user", public, pg_temp'],
    ["trailing_nbsp", "pg_catalog, pg_temp\u00a0", 'pg_catalog, "pg_temp\u00a0", pg_temp'],
    ["tab_separated", "pg_catalog,\tpg_temp", null],
    ["missing_comma", "pg_catalog pg_temp", explicitTrustedList],
    ["spaced_name", 'pg_catalog, "My Schema"', 'pg_catalog, "My Schema", pg_temp'],
    ["unterminated", 'pg_catalog, "pg_temp', explicitTrustedList],
    ["trailing_comma", "pg_catalog, pg_temp,", explicitTrustedList],
    ["keyword_name", '"select", pg_catalog', '"select", pg_catalog, pg_temp'],
    ["long_name", `${"a".repeat(70)}, pg_temp`, null],
    ["trailing_vt", "pg_catalog, pg_temp\v", 'pg_catalog, "pg_temp\v", pg_temp'],
    ["vt_separated", "pg_catalog,\vpg_temp", 'pg_catalog, "\vpg_temp", pg_temp'],
    ["toast_temp_earlier", "pg_catalog, pg_toast_temp_1, pg_temp", catalogPinned],
    ["toast_temp_last", "pg_catalog, pg_toast_temp_1", catalogPinned],
    ["temp_suffix_earlier", "pg_catalog, pg_temp_x, pg_temp", catalogPinned],
  ];
  const signature = (name: string) => `public.${name}()`;
  expect(searchPathFailures(cases.map(([name, search_path]) => ({ signature: signature(name), search_path }))))
    .toEqual(cases.flatMap(([name, , list]) => list === null ? [] : [searchPathRemedy(signature(name), list)]));
  expect(splitSearchPath(`"${"é".repeat(40)}"`)).toEqual(["é".repeat(31)]);
});

describe.concurrent("current installation definer search_path check", () => {
  it.concurrent.each(profiles)(
    "checks pg_temp last on every pinned function in a current %s installation",
    async profile => runInContainerSlot(async () => {
      const { owner, close } = await installAccountMutations(profile, false, "current-definer-search-path");
      try {
        const failures = searchPathFailures(await pinnedFunctions(owner));
        expect(failures, `${failures.length} functions need pg_temp last:\n${failures.join("\n")}`).toEqual([]);
        const installed = (await owner.query<{ signature: string; searchPath: string | null }>(`
          SELECT targets.signature, (SELECT pg_catalog.substr(setting, 13) FROM pg_catalog.unnest(p.proconfig) AS setting
                   WHERE pg_catalog.starts_with(setting, 'search_path=')) AS "searchPath"
          FROM pg_catalog.unnest($1::text[]) WITH ORDINALITY AS targets(signature, ordinal)
          LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(targets.signature)
          ORDER BY targets.ordinal
        `, [[...appendedSignatures, ...remainingSignatures]])).rows;
        expect(installed).toEqual([...appendedSettings, ...remainingSettings]);
        if (profile === "bootstrap") await checkScratchCensus(owner);
      } finally {
        await close();
      }
    }),
    postgresSetupTimeoutMs,
  );
});

describe.concurrent("acquisition definer search_path pin", () => {
  it.concurrent.each(profiles)(
    "pins pg_temp last on the acquisition functions in %s",
    async profile => runInContainerSlot(async () => {
      const { owner, migrator, installation, runner, close } = await installAtAcquisitionSearchPathBoundary(profile, "definer-search-path", "before-pin");
      try {
        expect(signatures).toHaveLength(11);
        const before = await observe(owner);
        expect(before.functions).toHaveLength(11);
        expect(before.functions.every(fn => fn.owner === slot.ownerWindowRole && fn.record.prosecdef)).toBe(true);
        const expected = before.functions.map((fn, index) => ({
          ...fn, record: { ...fn.record, proconfig: fn.record.proconfig.map(setting =>
            setting.startsWith("search_path=") ? `search_path=${settings[index]!.searchPath}` : setting) },
        }));
        expect(expected.filter((fn, index) => fn.record.proconfig.join() !== before.functions[index]!.record.proconfig.join()))
          .toHaveLength(profile === "legacy" ? 11 : 7);

        if (installation.generation === "qualified-admin") {
          const grantor = installation.roleMode === "installer-managed" ? installation.bootstrapLogin : installation.operatorLogin;
          expect(before.memberships.filter(row => row.role === slot.ownerWindowRole && row.member === installation.migrationLogin))
            .toEqual([expect.objectContaining({ grantor, admin_option: true, inherit_option: false, set_option: false })]);
          await rollBackPin(migrator, before.ledger);
          expect(await observe(owner)).toEqual(before);

          const sixth = signatures[5]!;
          expect(sixth).toMatch(/^public\.acquisition_newsletter_consent_v1\(/u);
          await owner.query(`ALTER FUNCTION ${sixth} OWNER TO "${installation.bootstrapLogin}"`);
          try {
            const beforeFailure = await observe(owner);
            await expect(runner.apply()).rejects.toThrow(
              `platform migration ${slot.path} failed: must be owner of function public.acquisition_newsletter_consent_v1`);
            expect(await observe(owner)).toEqual(beforeFailure);
          } finally {
            await owner.query(`ALTER FUNCTION ${sixth} OWNER TO platform_acquisition_owner`);
          }
          expect(await observe(owner)).toEqual(before);
        }

        expect((await runner.apply()).applied).toEqual([slot.path]);
        const after = await observe(owner);
        expect(after.functions).toEqual(expected);
        for (const fn of after.functions) {
          expect(fn.record.proconfig.filter(setting => setting.startsWith("search_path="))).toEqual(["search_path=pg_catalog, pg_temp"]);
        }
        expect(after.memberships).toEqual(before.memberships);
        expect(after.memberships.filter(row => row.role === slot.ownerWindowRole && row.member === row.grantor)).toEqual([]);
        expect(after.ledger).toEqual([...before.ledger, expect.objectContaining({
          catalog_path: slot.path, sha256: binding.sha256, position: before.ledger.length,
        })]);
        expect((await runner.apply()).applied).toEqual([]);
        expect(await observe(owner)).toEqual(after);

        const recorder = await owner.query(`SELECT prosecdef FROM pg_catalog.pg_proc
          WHERE oid='public.catalog_publication_record_command(jsonb)'::regprocedure`);
        expect(recorder.rows).toEqual([{ prosecdef: profile === "bootstrap" || profile === "separate" }]);
      } finally {
        await close();
      }
    }),
    postgresSetupTimeoutMs,
  );
});
