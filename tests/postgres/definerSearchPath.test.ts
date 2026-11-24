import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { expect, it } from "vitest";
import migrationManifest from "../../config/platform-migration-manifest.json" with { type: "json" };
import registry from "../../config/reviewed-platform-forwards.json" with { type: "json" };
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { fixture, graph, insertGraph, installPublicationActors, transaction } from "./catalogPublicationFixture.js";
import { acquisitionSearchPathManifest, installAccountMutations, installAtAcquisitionSearchPathBoundary } from "./customerAccountMutations.fixture.js";

const slot = registry.nativeStoreForwardClass.slots.find(entry => entry.path.endsWith("_acquisition_definer_search_path_pin.sql"))!;
const settings = slot.settingsOnlyFunctions!;
const signatures = settings.map(entry => entry.signature);
const binding = registry.nativeStoreForwards.find(entry => entry.path === slot.path)!;
const appended = registry.nativeStoreForwardClass.slots.find(entry => entry.path.endsWith("_function_search_path_pg_temp.sql"))!;
const appendedSettings = appended.settingsOnlyFunctions!;
const appendedSignatures = appendedSettings.map(entry => entry.signature);
const appendedBinding = registry.nativeStoreForwards.find(entry => entry.path === appended.path)!;
const appendedOrder = registry.nativeStoreForwards.findIndex(entry => entry.path === appended.path);
const laterReplacedByForward = new Set(
  appendedOrder >= 0
    ? registry.nativeStoreForwards
      .slice(appendedOrder + 1)
      .flatMap(entry => entry.functions.filter(fn => fn.beforeSha256 !== null).map(fn => fn.signature))
    : [],
);
const lockName = "openlup:public-platform-migrations:v1";
const ledger = "public.platform_schema_migrations";
const profiles = ["legacy", "bootstrap", "separate", "admin-managed", "admin-operator"] as const;
const prelockForward = registry.nativeStoreForwardClass.slots.find(entry => entry.row === "catalog-runtime-checkout-prelock")!;

// Functions outside public that still need pg_temp last. An entry that pins pg_temp last on every profile must be removed.
const SEARCH_PATH_PENDING = new Set([
  "acquisition_private.case_projection(uuid)",
  "acquisition_private.keyed_digest(text,jsonb)",
  "acquisition_private.partner_case_projection(uuid)",
  "acquisition_private.refuse_append_only_mutation()",
  "auth.uid()",
]);

type PinnedFunction = { signature: string; search_path: string | null };

// PostgreSQL 16 keywords that quote_identifier quotes (every category except unreserved).
const quotedKeywords = new Set(`all analyse analyze and any array as asc asymmetric authorization between bigint binary bit boolean both
  case cast char character check coalesce collate collation column concurrently constraint create cross current_catalog current_date
  current_role current_schema current_time current_timestamp current_user dec decimal default deferrable desc distinct do else end
  except exists extract false fetch float for foreign freeze from full grant greatest group grouping having ilike in initially inner
  inout int integer intersect interval into is isnull join json_array json_arrayagg json_object json_objectagg lateral leading least
  left like limit localtime localtimestamp national natural nchar none normalize not notnull null nullif numeric offset on only or order
  out outer overlaps overlay placing position precision primary real references returning right row select session_user setof similar
  smallint some substring symmetric system_user table tablesample then time timestamp to trailing treat trim true union unique user
  using values varchar variadic verbose when where window with xmlattributes xmlconcat xmlelement xmlexists xmlforest xmlnamespaces
  xmlparse xmlpi xmlroot xmlserialize xmltable`.split(/\s+/u));
const quoteIdentifier = (name: string) => /^[a-z_][a-z0-9_]*$/u.test(name) && !quotedKeywords.has(name) ? name : `"${name.replaceAll('"', '""')}"`;
// PostgreSQL 16 scanner whitespace; a newer server also accepts \v, which can only make this check stricter.
const sqlSpace = new Set([" ", "\t", "\n", "\r", "\f"]);
// Identifiers keep at most 63 bytes, cut at a character boundary.
function truncateIdentifier(name: string): string {
  const bytes = Buffer.from(name, "utf8");
  if (bytes.length <= 63) return name;
  let end = 63;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

// Split a search_path value as PostgreSQL does, or return null for a list it would reject.
function splitSearchPath(value: string): string[] | null {
  const names: string[] = [];
  let index = 0;
  const skipSpace = () => { while (index < value.length && sqlSpace.has(value[index]!)) index++; };
  skipSpace();
  if (index === value.length) return names;
  for (;;) {
    let name = "";
    if (value[index] === '"') {
      index++;
      for (;;) {
        const close = value.indexOf('"', index);
        if (close < 0) return null;
        name += value.slice(index, close);
        if (value[close + 1] !== '"') { index = close + 1; break; }
        name += '"';
        index = close + 2;
      }
    } else {
      const start = index;
      while (index < value.length && value[index] !== "," && !sqlSpace.has(value[index]!)) index++;
      if (index === start) return null;
      name = value.slice(start, index).replace(/[A-Z]/gu, letter => letter.toLowerCase());
    }
    names.push(truncateIdentifier(name));
    skipSpace();
    if (index === value.length) return names;
    if (value[index] !== ",") return null;
    index++;
    skipSpace();
  }
}

// PostgreSQL treats these names as temporary schemas, including TOAST ones.
const isTemporarySchema = (name: string) => name === "pg_temp" || name.startsWith("pg_temp_") || name.startsWith("pg_toast_temp_");

function searchPathFailures(functions: readonly PinnedFunction[]): string[] {
  const failures: string[] = [];
  for (const { signature, search_path: searchPath } of functions) {
    const names = searchPath === null ? null : splitSearchPath(searchPath);
    if (names && names.at(-1) === "pg_temp" && !names.slice(0, -1).some(isTemporarySchema)) continue;
    // Exact SQL needs a valid list whose remaining schemas are concrete names.
    const trusted = names?.filter(name => !isTemporarySchema(name)) ?? [];
    const remedy = trusted.length && trusted.every(name => name.length > 0 && name !== "$user")
      ? `ALTER FUNCTION ${signature} SET search_path = ${[...trusted, "pg_temp"].map(quoteIdentifier).join(", ")};`
      : "review and set an explicit trusted schema list, then append pg_temp";
    failures.push(`function ${signature}: pin pg_temp last: ${remedy}`);
  }
  return failures;
}

// Every non-system, non-extension definer, and every function that sets its own search path.
async function pinnedFunctions(owner: Pool) {
  return (await owner.query<PinnedFunction>(`
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
    WHERE (p.prosecdef OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p.proconfig) AS setting
             WHERE pg_catalog.starts_with(setting, 'search_path=')))
      AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend AS d
             WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid = p.oid AND d.deptype = 'e')
    ORDER BY 1
  `)).rows;
}

type LedgerRow = { catalog_path: string; sha256: string; position: number; executed_at: string };

async function readLedger(client: Pool | PoolClient) {
  return (await client.query<LedgerRow>(`SELECT catalog_path, sha256, position, executed_at::text
    FROM ${ledger} ORDER BY position`)).rows;
}

async function observe(owner: Pool, targets: readonly string[] = signatures) {
  const functions = (await owner.query<{ owner: string; record: { proconfig: string[]; prosecdef: boolean } }>(`
    SELECT r.rolname AS owner, pg_catalog.to_jsonb(p) AS record
    FROM pg_catalog.unnest($1::text[]) WITH ORDINALITY AS targets(signature, ordinal)
    JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(targets.signature)
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    ORDER BY targets.ordinal
  `, [targets])).rows;
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

async function rollBackPin(migrator: Pool, prefix: LedgerRow[], path = slot.path, sha256 = binding.sha256) {
  const client = await migrator.connect();
  try {
    await client.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1,0))", [lockName]);
    await client.query("BEGIN");
    try {
      await client.query(`LOCK TABLE ONLY ${ledger} IN SHARE ROW EXCLUSIVE MODE`);
      const ledgerIdentity = async () => (await client.query("SELECT 'public.platform_schema_migrations'::regclass::oid")).rows;
      const identity = await ledgerIdentity();
      expect(await readLedger(client)).toEqual(prefix);
      await client.query(readFileSync(path, "utf8"));
      expect(await ledgerIdentity()).toEqual(identity);
      expect(await readLedger(client)).toEqual(prefix);
      const { rows, rowCount } = await client.query(
        `INSERT INTO ${ledger} (catalog_path, sha256, position) VALUES ($1, $2, $3)
         RETURNING catalog_path, sha256, position`,
        [path, sha256, prefix.length],
      );
      expect(rowCount).toBe(1);
      expect(rows).toEqual([{ catalog_path: path, sha256, position: prefix.length }]);
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

// Installed counts that the appended forward changes; the rest already carry their final value.
const appendedChanges = { legacy: 392, bootstrap: 371, separate: 371, "admin-managed": 390, "admin-operator": 390 } as const;

it.each(profiles)(
  "appends pg_temp to pinned function search paths when upgrading %s",
  async profile => {
    const current = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
    if (current?.schemaVersion !== 3) throw new Error("Expected the complete platform migration catalogue");
    const prefix = structuredClone(current);
    for (const plan of [prefix, prefix.qualified, prefix.qualifiedAdmin]) {
      const position = plan.forward.findIndex(unit => unit.file === appended.path);
      expect(plan.forward[position]).toEqual({ file: appended.path, sha256: appendedBinding.sha256 });
      plan.forward = plan.forward.slice(0, position);
    }
    // The prefix inventory is measured, not pinned; the current runner then verifies the current inventory.
    const { owner, migrator, installation, runner, close } = await withPlatformCatalog(prefix, root =>
      installAccountMutations(profile, true, "function-search-path", root));
    try {
      // The guard refuses the pre-forward installation once for each function the forward changes.
      const baseFailures = searchPathFailures((await pinnedFunctions(owner)).filter(row => !SEARCH_PATH_PENDING.has(row.signature)));
      expect(baseFailures).toHaveLength(appendedChanges[profile]);
      console.info(`search-path guard base failures ${profile} ${baseFailures.length}`);
      const before = await observe(owner, appendedSignatures);
      const installer = installation.generation === "legacy" ? "postgres" : installation.migrationLogin;
      expect(before.functions.filter(fn => fn.owner !== installer)).toEqual([]);
      const expected = before.functions.map((fn, index) => ({
        ...fn, record: { ...fn.record, proconfig: fn.record.proconfig.map(setting =>
          setting.startsWith("search_path=") ? `search_path=${appendedSettings[index]!.searchPath}` : setting) },
      }));
      expect(expected.filter((fn, index) => fn.record.proconfig.join() !== before.functions[index]!.record.proconfig.join()))
        .toHaveLength(appendedChanges[profile]);

      if (installation.generation === "qualified-admin") {
        await rollBackPin(migrator, before.ledger, appended.path, appendedBinding.sha256);
        expect(await observe(owner, appendedSignatures)).toEqual(before);
        // A function the installer does not own stops the forward before any setting commits.
        const target = appendedSignatures[193]!;
        await owner.query(`ALTER FUNCTION ${target} OWNER TO "${installation.bootstrapLogin}"`);
        try {
          const beforeFailure = await observe(owner, appendedSignatures);
          await expect(runner.apply()).rejects.toThrow(
            `platform migration ${appended.path} failed: must be owner of function ${target.slice(0, target.indexOf("("))}`);
          expect(await observe(owner, appendedSignatures)).toEqual(beforeFailure);
        } finally {
          await owner.query(`ALTER FUNCTION ${target} OWNER TO "${installer}"`);
        }
        expect(await observe(owner, appendedSignatures)).toEqual(before);
      }

      // Verify the search-path forward alone changes only proconfig before later forwards run.
      const pinCheck = await migrator.connect();
      try {
        await pinCheck.query("BEGIN");
        await pinCheck.query(readFileSync(appended.path, "utf8"));
        expect((await pinCheck.query<{ owner: string; record: { proconfig: string[]; prosecdef: boolean } }>(`
          SELECT r.rolname AS owner, pg_catalog.to_jsonb(p) AS record
          FROM pg_catalog.unnest($1::text[]) WITH ORDINALITY AS targets(signature, ordinal)
          JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(targets.signature)
          JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
          ORDER BY targets.ordinal
        `, [appendedSignatures])).rows).toEqual(expected);
        await pinCheck.query("ROLLBACK");
      } finally {
        pinCheck.release();
      }

      expect((await runner.apply()).applied[0]).toBe(appended.path);
      const after = await observe(owner, appendedSignatures);
      const unchangedIndices = appendedSignatures.flatMap((signature, index) => (laterReplacedByForward.has(signature) ? [] : [index]));
      expect(unchangedIndices.map(index => after.functions[index])).toEqual(unchangedIndices.map(index => expected[index]));
      for (const [index, signature] of appendedSignatures.entries()) {
        if (!laterReplacedByForward.has(signature)) continue;
        const fn = after.functions[index]!;
        expect(fn.owner).toBe(expected[index]!.owner);
        const searchPath = fn.record.proconfig.find(setting => setting.startsWith("search_path="))?.slice(12) ?? null;
        expect(searchPathFailures([{ signature, search_path: searchPath }])).toEqual([]);
      }
      expect(after.memberships).toEqual(before.memberships);
      expect(after.ledger.slice(0, before.ledger.length + 1)).toEqual([...before.ledger, expect.objectContaining({
        catalog_path: appended.path, sha256: appendedBinding.sha256, position: before.ledger.length,
      })]);
      expect((await runner.apply()).applied).toEqual([]);
      expect(await observe(owner, appendedSignatures)).toEqual(after);
    } finally {
      await close();
    }
  },
  postgresSetupTimeoutMs,
);

// Pending entries that still fail on each profile; an entry fixed on every profile must leave the list.
const pendingStillFailing = new Map<string, Set<string>>();

it.each(profiles)(
  "checks pg_temp last on every pinned function in a current %s installation",
  async profile => {
    const { owner, close } = await installAccountMutations(profile, false, "current-definer-search-path");
    try {
      const rows = await pinnedFunctions(owner);
      expect([...SEARCH_PATH_PENDING].filter(signature => !rows.some(row => row.signature === signature))).toEqual([]);
      const failures = searchPathFailures(rows.filter(row => !SEARCH_PATH_PENDING.has(row.signature)));
      expect(failures, `${failures.length} functions need pg_temp last:\n${failures.join("\n")}`).toEqual([]);
      pendingStillFailing.set(profile, new Set(rows.filter(row => SEARCH_PATH_PENDING.has(row.signature)
        && searchPathFailures([row]).length > 0).map(row => row.signature)));
      const installed = (await owner.query<{ signature: string; searchPath: string | null }>(`
        SELECT targets.signature, (SELECT pg_catalog.substr(setting, 13) FROM pg_catalog.unnest(p.proconfig) AS setting
                 WHERE pg_catalog.starts_with(setting, 'search_path=')) AS "searchPath"
        FROM pg_catalog.unnest($1::text[]) WITH ORDINALITY AS targets(signature, ordinal)
        LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(targets.signature)
        ORDER BY targets.ordinal
      `, [appendedSignatures])).rows;
      expect(installed).toEqual(appendedSettings);
    } finally {
      await close();
    }
  },
  postgresSetupTimeoutMs,
);

it("keeps only pending functions that still need pg_temp last on some profile", () => {
  expect([...pendingStillFailing.keys()].sort()).toEqual([...profiles].sort());
  const stale = [...SEARCH_PATH_PENDING].filter(signature => ![...pendingStillFailing.values()].some(failing => failing.has(signature)));
  expect(stale.map(signature => `remove ${signature} from SEARCH_PATH_PENDING: it now pins pg_temp last`)).toEqual([]);
});

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
    "function public.unpinned(): pin pg_temp last: ALTER FUNCTION public.unpinned() SET search_path = pg_catalog, public, pg_temp;",
    "function public.no_setting(): pin pg_temp last: review and set an explicit trusted schema list, then append pg_temp",
    "function public.empty_setting(): pin pg_temp last: review and set an explicit trusted schema list, then append pg_temp",
    "function public.quoted_empty_setting(): pin pg_temp last: review and set an explicit trusted schema list, then append pg_temp",
    "function public.temp_only(): pin pg_temp last: review and set an explicit trusted schema list, then append pg_temp",
    "function public.temp_first(): pin pg_temp last: ALTER FUNCTION public.temp_first() SET search_path = public, pg_temp;",
    'function public.temp_repeated(): pin pg_temp last: ALTER FUNCTION public.temp_repeated() SET search_path = "schema, name", public, pg_temp;',
    "function public.temp_duplicated(): pin pg_temp last: ALTER FUNCTION public.temp_duplicated() SET search_path = pg_catalog, pg_temp;",
    "function public.temp_numbered(): pin pg_temp last: ALTER FUNCTION public.temp_numbered() SET search_path = pg_catalog, pg_temp;",
    'function public.quoted_upper_last(): pin pg_temp last: ALTER FUNCTION public.quoted_upper_last() SET search_path = pg_catalog, "PG_TEMP", pg_temp;',
    'function public.quoted_case(): pin pg_temp last: ALTER FUNCTION public.quoted_case() SET search_path = "PG_TEMP", pg_temp;',
  ]);
});

it("parses search paths as PostgreSQL does and prints exact SQL only for a concrete schema list", () => {
  const manual = (signature: string) => `function ${signature}: pin pg_temp last: review and set an explicit trusted schema list, then append pg_temp`;
  expect(searchPathFailures([
    { signature: "public.trailing_nbsp()", search_path: "pg_catalog, pg_temp " },
    { signature: "public.tab_separated()", search_path: "pg_catalog,\tpg_temp" },
    { signature: "public.unquoted_upper()", search_path: "pg_catalog, PG_TEMP" },
    { signature: "public.quoted_upper()", search_path: 'pg_catalog, "PG_TEMP"' },
    { signature: "public.quoted_lower()", search_path: 'pg_catalog, "pg_temp"' },
    { signature: "public.missing_comma()", search_path: "pg_catalog pg_temp" },
    { signature: "public.user_schema()", search_path: '"$user", public' },
    { signature: "public.known_list()", search_path: "pg_catalog, public" },
    { signature: "public.spaced_name()", search_path: 'pg_catalog, "My Schema"' },
    { signature: "public.unterminated()", search_path: 'pg_catalog, "pg_temp' },
    { signature: "public.trailing_comma()", search_path: "pg_catalog, pg_temp," },
    { signature: "public.keyword_name()", search_path: '"select", pg_catalog' },
    { signature: "public.long_name()", search_path: `${"a".repeat(70)}, pg_temp` },
    { signature: "public.trailing_vt()", search_path: "pg_catalog, pg_temp\v" },
    { signature: "public.vt_separated()", search_path: "pg_catalog,\vpg_temp" },
    { signature: "public.toast_temp_earlier()", search_path: "pg_catalog, pg_toast_temp_1, pg_temp" },
    { signature: "public.toast_temp_last()", search_path: "pg_catalog, pg_toast_temp_1" },
    { signature: "public.temp_suffix_earlier()", search_path: "pg_catalog, pg_temp_x, pg_temp" },
  ])).toEqual([
    'function public.trailing_nbsp(): pin pg_temp last: ALTER FUNCTION public.trailing_nbsp() SET search_path = pg_catalog, "pg_temp ", pg_temp;',
    'function public.quoted_upper(): pin pg_temp last: ALTER FUNCTION public.quoted_upper() SET search_path = pg_catalog, "PG_TEMP", pg_temp;',
    manual("public.missing_comma()"),
    manual("public.user_schema()"),
    "function public.known_list(): pin pg_temp last: ALTER FUNCTION public.known_list() SET search_path = pg_catalog, public, pg_temp;",
    'function public.spaced_name(): pin pg_temp last: ALTER FUNCTION public.spaced_name() SET search_path = pg_catalog, "My Schema", pg_temp;',
    manual("public.unterminated()"),
    manual("public.trailing_comma()"),
    'function public.keyword_name(): pin pg_temp last: ALTER FUNCTION public.keyword_name() SET search_path = "select", pg_catalog, pg_temp;',
    'function public.trailing_vt(): pin pg_temp last: ALTER FUNCTION public.trailing_vt() SET search_path = pg_catalog, "pg_temp\v", pg_temp;',
    'function public.vt_separated(): pin pg_temp last: ALTER FUNCTION public.vt_separated() SET search_path = pg_catalog, "\vpg_temp", pg_temp;',
    "function public.toast_temp_earlier(): pin pg_temp last: ALTER FUNCTION public.toast_temp_earlier() SET search_path = pg_catalog, pg_temp;",
    "function public.toast_temp_last(): pin pg_temp last: ALTER FUNCTION public.toast_temp_last() SET search_path = pg_catalog, pg_temp;",
    "function public.temp_suffix_earlier(): pin pg_temp last: ALTER FUNCTION public.temp_suffix_earlier() SET search_path = pg_catalog, pg_temp;",
  ]);
  expect(splitSearchPath(`"${"é".repeat(40)}"`)).toEqual(["é".repeat(31)]);
});

it.each(profiles)("preserves the runtime checkout identity and ACLs through the prelock upgrade on %s", async profile => {
  if (migrationManifest.schemaVersion !== 3) throw new Error("Expected the complete platform migration catalogue");
  const prefix: Extract<PlatformMigrationManifest, { schemaVersion: 3 }> = { ...structuredClone(migrationManifest), schemaVersion: 3 };
  for (const plan of [prefix, prefix.qualified, prefix.qualifiedAdmin]) {
    const first = plan.forward.findIndex(unit => unit.file === prelockForward.path);
    expect(first).toBeGreaterThan(0);
    plan.forward = plan.forward.slice(0, first);
  }
  const { owner, runner, runtime, close } = await withPlatformCatalog(prefix, root => installAccountMutations(profile, true, "checkout-prelock", root));
  try {
    const signature = prelockForward.replacedFunctions[0]!.signature;
    const facts = async () => (await owner.query(`SELECT to_jsonb(p)-'prosrc' AS routine,p.prosrc AS body,
      (SELECT jsonb_agg(jsonb_build_array(r.rolname,has_function_privilege(r.oid,p.oid,'EXECUTE')) ORDER BY r.rolname) FROM pg_roles r) AS acl,
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.oid) FROM pg_default_acl a) AS defaults
      FROM pg_proc p WHERE p.oid=$1::regprocedure`, [signature])).rows[0]!;
    const { body, ...prior } = await facts();
    expect((await runner.apply()).applied[0]).toBe(prelockForward.path);
    expect((await runner.apply()).applied).toEqual([]);
    const { body: installed, ...after } = await facts();
    expect(after).toEqual(prior);
    expect(installed).not.toBe(body);
    expect(after.routine).toMatchObject({ prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"] });

    const helpers = ["catalog_admission_lock_shared()", "catalog_admission_lock_checkout_price(uuid,uuid[])",
      "catalog_price_setup_lock_context(uuid,uuid)"];
    expect((await owner.query(`SELECT p.proowner::text,p.proconfig FROM unnest($1::text[]) s
      JOIN pg_proc p ON p.oid=('public.'||s)::regprocedure`, [helpers])).rows)
      .toEqual(helpers.map(() => ({ proowner: after.routine.proowner, proconfig: ["search_path=pg_catalog, pg_temp"] })));
    const { rows: [login] } = await runtime.query("SELECT current_user AS name");
    expect((await owner.query(`SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[]) AND NOT rolsuper
      AND has_schema_privilege(oid,'public','CREATE')
      UNION ALL SELECT 'PUBLIC' FROM pg_namespace n,aclexplode(n.nspacl) a
      WHERE n.nspname='public' AND a.grantee=0 AND a.privilege_type='CREATE'`,
    [[login.name, "service_role", "anon", "authenticated", "openlup_catalog_publication"]])).rows).toEqual([]);

    await installPublicationActors(owner);
    const scope = await transaction(owner, async db => {
      const issue = await graph(db, fixture(), null, true, { lifecycle: "active", subscriptionEligible: true });
      await insertGraph(db, issue);
      const legacy = fixture();
      await db.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Example')", [legacy.productId, legacy.productId]);
      await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription) VALUES($1,$2,$3,'Example',true)",
        [legacy.skuId, legacy.productId, legacy.skuId]);
      const { rows: [list] } = await db.query("INSERT INTO public.price_lists(name,region_code,currency) VALUES('Example','ZZ','XXX') RETURNING id");
      const { rows: [client] } = await db.query("INSERT INTO public.clients(email) VALUES('prelock@example.invalid') RETURNING id");
      return { client: client.id, payload: { skuIds: [issue.skuId, legacy.skuId], skuRevisionId: issue.skuRevisionId, priceListId: list.id } };
    });
    const call = "SELECT public.catalog_admission_runtime_checkout($1::pg_catalog.text,$2::pg_catalog.text,$3::pg_catalog.uuid,$4::pg_catalog.jsonb) AS result";
    const key = "fixture-checkout-key";
    await transaction(runtime, async db => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await db.query("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='3s'; SET LOCAL search_path=pg_temp,public,pg_catalog");
      await db.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))", [key]);
      await db.query("CREATE TEMP TABLE clients(id pg_catalog.uuid) ON COMMIT DROP");
      expect((await db.query(call, ["prelock", key, scope.client, scope.payload])).rows).toEqual([{ result: { kind: "locked" } }]);
    });
    await expect(runtime.query(call, ["write", key, scope.client, scope.payload])).rejects.toMatchObject({
      code: "55000", message: "catalog_admission_quote_authority_required",
      hint: "Governed checkout is unavailable for this selection. Use a supported offer or replay the original request.",
    });
  } finally { await close(); }
}, postgresSetupTimeoutMs);
