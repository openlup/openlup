import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { expect, it } from "vitest";
import registry from "../../config/reviewed-platform-forwards.json" with { type: "json" };
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { acquisitionSearchPathManifest, installAccountMutations, installAtAcquisitionSearchPathBoundary } from "./customerAccountMutations.fixture.js";

const slot = registry.nativeStoreForwardClass.slots.find(entry => entry.path.endsWith("_acquisition_definer_search_path_pin.sql"))!;
const settings = slot.settingsOnlyFunctions!;
const signatures = settings.map(entry => entry.signature);
const binding = registry.nativeStoreForwards.find(entry => entry.path === slot.path)!;
const lockName = "openlup:public-platform-migrations:v1";
const ledger = "public.platform_schema_migrations";
const profiles = ["legacy", "bootstrap", "separate", "admin-managed", "admin-operator"] as const;

type Definer = { signature: string; search_path: string | null };

function searchPathFailures(definers: readonly Definer[]): string[] {
  const failures: string[] = [];
  const temporarySchema = /^pg_temp(?:_\d+)?$/u;
  for (const { signature, search_path: searchPath } of definers) {
    // Keep commas and case inside quoted schema names.
    const schemas = (searchPath?.match(/(?:[^",]|"(?:[^"]|"")*")+/g) ?? [])
      .map(schema => schema.trim())
      .map(schema => ({ schema, name: schema.startsWith('"')
        ? schema.slice(1, -1).replaceAll('""', '"') : schema.toLowerCase() }))
      .filter(({ name }) => name.length > 0);
    const names = schemas.map(({ name }) => name);
    if (names.at(-1) === "pg_temp" && !names.slice(0, -1).some(name => temporarySchema.test(name))) continue;
    const trusted = schemas.filter(({ name }) => !temporarySchema.test(name)).map(({ schema }) => schema);
    const remedy = trusted.length ? `SET search_path = ${[...trusted, "pg_temp"].join(", ")}`
      : "review and set an explicit trusted schema list, then append pg_temp";
    failures.push(`SECURITY DEFINER function ${signature}: pin pg_temp last: ${remedy}`);
  }
  return failures;
}

type LedgerRow = { catalog_path: string; sha256: string; position: number; executed_at: string };

async function readLedger(client: Pool | PoolClient) {
  return (await client.query<LedgerRow>(`SELECT catalog_path, sha256, position, executed_at::text
    FROM ${ledger} ORDER BY position`)).rows;
}

async function observe(owner: Pool) {
  const functions = (await owner.query<{ owner: string; record: { proconfig: string[]; prosecdef: boolean } }>(`
    SELECT r.rolname AS owner, pg_catalog.to_jsonb(p) AS record
    FROM pg_catalog.unnest($1::text[]) WITH ORDINALITY AS targets(signature, ordinal)
    JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(targets.signature)
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    ORDER BY targets.ordinal
  `, [signatures])).rows;
  const memberships = (await owner.query<{
    role: string; member: string; grantor: string; admin_option: boolean; inherit_option: boolean; set_option: boolean;
  }>(`SELECT a.*, r.rolname AS role, m.rolname AS member, g.rolname AS grantor
    FROM pg_catalog.pg_auth_members a
    JOIN pg_catalog.pg_roles r ON r.oid = a.roleid
    JOIN pg_catalog.pg_roles m ON m.oid = a.member
    JOIN pg_catalog.pg_roles g ON g.oid = a.grantor
    ORDER BY a.oid`)).rows;
  return { functions, memberships, ledger: await readLedger(owner) };
}

async function rollBackPin(migrator: Pool, prefix: LedgerRow[]) {
  const client = await migrator.connect();
  try {
    await client.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1,0))", [lockName]);
    await client.query("BEGIN");
    try {
      await client.query(`LOCK TABLE ONLY ${ledger} IN SHARE ROW EXCLUSIVE MODE`);
      const ledgerIdentity = async () => (await client.query("SELECT 'public.platform_schema_migrations'::regclass::oid")).rows;
      const identity = await ledgerIdentity();
      expect(await readLedger(client)).toEqual(prefix);
      await client.query(readFileSync(slot.path, "utf8"));
      expect(await ledgerIdentity()).toEqual(identity);
      expect(await readLedger(client)).toEqual(prefix);
      const { rows, rowCount } = await client.query(
        `INSERT INTO ${ledger} (catalog_path, sha256, position) VALUES ($1, $2, $3)
         RETURNING catalog_path, sha256, position`,
        [slot.path, binding.sha256, prefix.length],
      );
      expect(rowCount).toBe(1);
      expect(rows).toEqual([{ catalog_path: slot.path, sha256: binding.sha256, position: prefix.length }]);
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    const unlock = await client.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1,0)) AS unlocked", [lockName])
      .catch(() => undefined);
    const unlocked = unlock?.rows[0]?.unlocked === true;
    client.release(!unlocked);
    expect(unlocked).toBe(true);
  }
}

it.each(profiles)(
  "pins pg_temp last on the acquisition functions in %s",
  async profile => {
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
  },
  postgresSetupTimeoutMs,
);

it.each(profiles)(
  "checks pg_temp last on every definer in a current %s installation",
  async profile => {
    const { owner, close } = await installAccountMutations(profile, false, "current-definer-search-path");
    try {
      const { rows } = await owner.query<Definer>(`
        SELECT pg_catalog.format('%I.%I(%s)', n.nspname, p.proname,
                 pg_catalog.array_to_string(ARRAY(
                   SELECT pg_catalog.format_type(arg, NULL)
                   FROM pg_catalog.unnest(p.proargtypes) WITH ORDINALITY AS args(arg, position)
                   ORDER BY position
                 ), ',')) AS signature,
               (SELECT pg_catalog.substr(setting, 13)
                FROM pg_catalog.unnest(p.proconfig) AS setting
                WHERE pg_catalog.starts_with(setting, 'search_path=')) AS search_path
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prosecdef AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        ORDER BY 1
      `);
      const failures = searchPathFailures(rows);
      expect(failures, failures.join("\n")).toEqual([]);
    } finally {
      await close();
    }
  },
  postgresSetupTimeoutMs,
);

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

it("reports how to pin pg_temp last while preserving quoted schema names", () => {
  expect(searchPathFailures([
    { signature: "public.unpinned()", search_path: "pg_catalog, public" },
    { signature: "public.no_setting()", search_path: null },
    { signature: "public.empty_setting()", search_path: "" },
    { signature: "public.quoted_empty_setting()", search_path: '""' },
    { signature: "public.temp_only()", search_path: "pg_Temp_12" },
    { signature: "public.temp_first()", search_path: "PG_TEMP, public" },
    { signature: "public.temp_repeated()", search_path: 'pg_temp, "pg_temp", "schema, name", public' },
    { signature: "public.temp_duplicated()", search_path: '"pg_temp", pg_catalog, pg_temp' },
    { signature: "public.temp_numbered()", search_path: '"pg_temp_12", pg_catalog, pg_temp' },
    { signature: "public.quoted_upper_last()", search_path: 'pg_catalog, "PG_TEMP"' },
    { signature: "public.quoted_case()", search_path: '"PG_TEMP", "pg_temp_12A", pg_temp' },
    { signature: "public.quoted_comma()", search_path: '"schema, pg_temp, name", pg_temp' },
    { signature: "public.pinned()", search_path: 'pg_catalog, "pg_temp"' },
    { signature: "public.unquoted_upper()", search_path: "pg_catalog, PG_TEMP" },
  ])).toEqual([
    "SECURITY DEFINER function public.unpinned(): pin pg_temp last: SET search_path = pg_catalog, public, pg_temp",
    "SECURITY DEFINER function public.no_setting(): pin pg_temp last: review and set an explicit trusted schema list, then append pg_temp",
    "SECURITY DEFINER function public.empty_setting(): pin pg_temp last: review and set an explicit trusted schema list, then append pg_temp",
    "SECURITY DEFINER function public.quoted_empty_setting(): pin pg_temp last: review and set an explicit trusted schema list, then append pg_temp",
    "SECURITY DEFINER function public.temp_only(): pin pg_temp last: review and set an explicit trusted schema list, then append pg_temp",
    "SECURITY DEFINER function public.temp_first(): pin pg_temp last: SET search_path = public, pg_temp",
    'SECURITY DEFINER function public.temp_repeated(): pin pg_temp last: SET search_path = "schema, name", public, pg_temp',
    "SECURITY DEFINER function public.temp_duplicated(): pin pg_temp last: SET search_path = pg_catalog, pg_temp",
    "SECURITY DEFINER function public.temp_numbered(): pin pg_temp last: SET search_path = pg_catalog, pg_temp",
    'SECURITY DEFINER function public.quoted_upper_last(): pin pg_temp last: SET search_path = pg_catalog, "PG_TEMP", pg_temp',
  ]);
});
