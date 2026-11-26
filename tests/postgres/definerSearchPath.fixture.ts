import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { expect } from "vitest";
import registry from "../../config/reviewed-platform-forwards.json" with { type: "json" };
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { installAccountMutations } from "./customerAccountMutations.fixture.js";

export {
  acquisitionSearchPathManifest,
  installAccountMutations,
  installAtAcquisitionSearchPathBoundary,
} from "./customerAccountMutations.fixture.js";

export const slot = registry.nativeStoreForwardClass.slots.find(entry => entry.path.endsWith("_acquisition_definer_search_path_pin.sql"))!;
export const settings = slot.settingsOnlyFunctions!;
export const signatures = settings.map(entry => entry.signature);
export const binding = registry.nativeStoreForwards.find(entry => entry.path === slot.path)!;
export const appended = registry.nativeStoreForwardClass.slots.find(entry => entry.path.endsWith("_function_search_path_pg_temp.sql"))!;
export const appendedSettings = appended.settingsOnlyFunctions!;
export const appendedSignatures = appendedSettings.map(entry => entry.signature);
export const appendedBinding = registry.nativeStoreForwards.find(entry => entry.path === appended.path)!;
const appendedOrder = registry.nativeStoreForwards.findIndex(entry => entry.path === appended.path);
export const remaining = registry.nativeStoreForwardClass.slots.find(entry => entry.path.endsWith("_function_search_path_pin_remaining.sql"))!;
export const remainingSettings = remaining.settingsOnlyFunctions!;
export const remainingSignatures = remainingSettings.map(entry => entry.signature);
export const remainingBinding = registry.nativeStoreForwards.find(entry => entry.path === remaining.path)!;
export const laterReplacedByForward = new Set(
  appendedOrder >= 0
    ? registry.nativeStoreForwards
      .slice(appendedOrder + 1)
      .flatMap(entry => entry.functions.filter(fn => fn.beforeSha256 !== null).map(fn => fn.signature))
    : [],
);
const lockName = "openlup:public-platform-migrations:v1";
const ledger = "public.platform_schema_migrations";
// These self-host profiles install auth.uid(). Managed auth.uid() is provider-owned and outside this check.
export const profiles = ["legacy", "bootstrap", "separate", "admin-managed", "admin-operator"] as const;
export const prelockForward = registry.nativeStoreForwardClass.slots.find(entry => entry.row === "catalog-runtime-checkout-prelock")!;

export const catalogOnly = "pg_catalog";
export const catalogPinned = "pg_catalog, pg_temp";
export const explicitTrustedList = "an explicit trusted schema list";

export type PinnedFunction = { signature: string; search_path: string | null };
export type LedgerRow = { catalog_path: string; sha256: string; position: number; executed_at: string };

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
export const quoteIdentifier = (name: string) => /^[a-z_][a-z0-9_]*$/u.test(name) && !quotedKeywords.has(name) ? name : `"${name.replaceAll('"', '""')}"`;
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
export function splitSearchPath(value: string): string[] | null {
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

export function searchPathRemedy(signature: string, list: string): string {
  return `Function ${signature} must pin pg_temp once, last. If its defining migration is unissued, set \`SET search_path = ${list}\` in that definition. If it is issued, add a reviewed settings-only forward with \`ALTER FUNCTION ${signature} SET search_path = ${list};\`. Rerun \`tests/postgres/definerSearchPath.test.ts\`.`;
}

export function searchPathFailures(functions: readonly PinnedFunction[]): string[] {
  const failures: string[] = [];
  for (const { signature, search_path: searchPath } of functions) {
    const names = searchPath === null ? null : splitSearchPath(searchPath);
    if (names && names.at(-1) === "pg_temp" && !names.slice(0, -1).some(name => name === "" || isTemporarySchema(name))) continue;
    const trusted = names?.filter(name => name !== "" && !isTemporarySchema(name)) ?? [];
    const list = trusted.some(name => name !== "$user")
      ? [...trusted, "pg_temp"].map(quoteIdentifier).join(", ")
      : explicitTrustedList;
    failures.push(searchPathRemedy(signature, list));
  }
  return failures;
}

// Every non-system, non-extension definer, and every function that sets its own search path.
export async function pinnedFunctions(owner: Pool | PoolClient) {
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

export async function readLedger(client: Pool | PoolClient) {
  return (await client.query<LedgerRow>(`SELECT catalog_path, sha256, position, executed_at::text
    FROM ${ledger} ORDER BY position`)).rows;
}

export async function observe(owner: Pool | PoolClient, targets: readonly string[] = signatures, knownOids: readonly number[] = []) {
  const functions = (await owner.query<{ owner: string; record: { oid: number; proconfig: string[]; prosecdef: boolean } }>(`
    SELECT r.rolname AS owner, pg_catalog.to_jsonb(p) AS record
    FROM ROWS FROM (pg_catalog.unnest($1::text[]), pg_catalog.unnest($2::oid[])) WITH ORDINALITY AS targets(signature, oid, ordinal)
    JOIN pg_catalog.pg_proc p ON p.oid = COALESCE(targets.oid, pg_catalog.to_regprocedure(targets.signature)::oid)
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    ORDER BY targets.ordinal
  `, [targets, knownOids])).rows;
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

export async function rollBackPin(migrator: Pool, prefix: LedgerRow[], path = slot.path, sha256 = binding.sha256,
  afterInsert?: (client: PoolClient) => Promise<void>) {
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
      await afterInsert?.(client);
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

// Bound disposable PostgreSQL container concurrency to maxSlots per file to match hosted runner budgets.
export function withContainerSlot(maxSlots = 2) {
  let activeContainerSlots = 0;
  const waitingContainerSlots: (() => void)[] = [];
  return async function runWithContainerSlot<T>(work: () => Promise<T>): Promise<T> {
    while (activeContainerSlots >= maxSlots) await new Promise<void>(resolve => { waitingContainerSlots.push(resolve); });
    activeContainerSlots++;
    try { return await work(); }
    finally {
      activeContainerSlots--;
      waitingContainerSlots.shift()?.();
    }
  };
}

export async function installBeforeForward(profile: typeof profiles[number], label: string, { path, sha256 }: { path: string; sha256: string }) {
  const current = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
  if (current?.schemaVersion !== 3) throw new Error("Expected the complete platform migration catalogue");
  for (const plan of [current, current.qualified, current.qualifiedAdmin]) {
    const position = plan.forward.findIndex(unit => unit.file === path);
    expect(plan.forward[position]).toEqual({ file: path, sha256 });
    plan.forward = plan.forward.slice(0, position);
  }
  // Measure the prefix inventory, then verify the current inventory when upgrading.
  return withPlatformCatalog(current, root => installAccountMutations(profile, true, label, root));
}
