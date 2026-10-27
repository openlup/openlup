import { createHash } from "node:crypto";

/** A finite compatible-row utility, not a complete-store migration profile. */
const TABLES = [
  "clients", "subscriptions", "subscription_events", "subscription_pause_windows",
  "subscription_renewal_terms", "subscription_renewal_term_lines", "subscription_renewal_operations",
  "subscription_cycles", "commerce_orders", "commerce_order_items", "commerce_settlement_intents",
  "commerce_settlement_transitions", "payment_truth_events", "payment_truth_reconciliation_evidence",
  "subscription_renewal_outcomes", "outbox_events", "invoicing_duties", "invoicing_fact_revisions",
  "invoicing_effect_receipts", "invoicing_capture_faults",
] as const;
export type CompatiblePostgresTable = typeof TABLES[number];
export interface TransferPostgresQuery {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[] }>;
}
export interface CompatiblePostgresSnapshot {
  /** Own one read-only, repeatable-read transaction for the complete callback. */
  withSnapshot<T>(work: (db: TransferPostgresQuery) => Promise<T>): Promise<T>;
}
export interface CompatiblePostgresTarget {
  /** Own one transaction; commit only after the complete callback succeeds. */
  withTransaction<T>(work: (db: TransferPostgresQuery) => Promise<T>): Promise<T>;
}
type Column = { name: string; type: string; key: boolean };
type TableRows = { table: CompatiblePostgresTable; columns: Column[]; rows: string[] };
export interface CompatiblePostgresPacket {
  format: "openlup.compatible-rows.v1";
  sourceId: string;
  /** Opaque selected-catalogue identity supplied by the validated host capability. */
  catalogueId: string;
  tables: TableRows[];
  sha256: string;
}
export type PostgresTransferFailure = "invalid_input" | "unsupported_table" | "schema_conflict"
  | "insert_trigger_requires_owner" | "target_conflict" | "limit_exceeded" | "database_unavailable";
export class PostgresTransferError extends Error {
  constructor(readonly code: PostgresTransferFailure, readonly table?: string) {
    super(`postgres_transfer_${code}${table ? `:${table}` : ""}`);
    this.name = "PostgresTransferError";
  }
}
const LIMIT_ROWS = 10000, LIMIT_BYTES = 64 * 1024 * 1024;

/** Data only: no schema, role, grant, migration ledger, control or provider-internal copy. */
export async function captureCompatiblePostgresRows(input: {
  source: CompatiblePostgresSnapshot; sourceId: string; catalogueId: string;
  tables: readonly CompatiblePostgresTable[]; maximumRows: number; maximumBytes: number;
}): Promise<CompatiblePostgresPacket> {
  const { sourceId, catalogueId, maximumRows, maximumBytes } = input;
  if (!identity(sourceId) || !identity(catalogueId) || !ceiling(maximumRows, LIMIT_ROWS) || !ceiling(maximumBytes, LIMIT_BYTES)) fail("invalid_input");
  const names = tableNames(input.tables);
  try {
    const tables = await input.source.withSnapshot(async db => {
      const mode = (await db.query("SELECT current_setting('transaction_read_only') AS readonly, current_setting('transaction_isolation') AS isolation")).rows[0];
      if (mode?.readonly !== "on" || mode.isolation !== "repeatable read") fail("invalid_input");
      await db.query("SET LOCAL TimeZone = 'UTC'");
      let count = 0, bytes = 0;
      const result: TableRows[] = [];
      for (const table of names) {
        const columns = await inspect(db, table);
        const order = columns.filter(column => column.key).map(column => quoted(column.name)).join(",");
        // PostgreSQL serializes bigint, numeric, bytea and timestamp values.
        // Retain that JSON text unchanged; a JS numeric round trip is lossy.
        const rows = (await db.query<{ value: string }>(`SELECT to_jsonb(t)::text AS value FROM public.${quoted(table)} t ORDER BY ${order} LIMIT $1`, [maximumRows + 1])).rows.map(row => row.value);
        for (const row of rows) { count++; bytes += Buffer.byteLength(row); }
        if (count > maximumRows || bytes > maximumBytes) fail("limit_exceeded", table);
        result.push({ table, columns, rows });
      }
      return result;
    });
    const packet = { format: "openlup.compatible-rows.v1" as const, sourceId, catalogueId, tables };
    return { ...packet, sha256: digest(packet) };
  } catch (error) { throw redacted(error); }
}

/**
 * Atomic insert and exact replay. A differing row refuses; there is no upsert,
 * deletion scan, status reset or permission change. Existing parent rows remain
 * prerequisites, and this utility never authorizes target effect execution.
 */
export async function restoreCompatiblePostgresRows(input: {
  target: CompatiblePostgresTarget; catalogueId: string; packet: CompatiblePostgresPacket;
}): Promise<{ inserted: number; replayed: number; sha256: string }> {
  // Own immutable input bytes throughout async validation and writes.
  let packet: CompatiblePostgresPacket;
  try { packet = JSON.parse(JSON.stringify(input.packet)) as CompatiblePostgresPacket; validatePacket(packet); }
  catch (error) { if (error instanceof PostgresTransferError) throw error; fail("invalid_input"); }
  if (packet.catalogueId !== input.catalogueId) fail("schema_conflict");
  try {
    return await input.target.withTransaction(async db => {
      const mode = (await db.query("SELECT current_setting('session_replication_role') AS mode")).rows[0];
      if (mode?.mode !== "origin") fail("invalid_input");
      await db.query("SET LOCAL TimeZone = 'UTC'");
      // Serializes writers and prevents DDL between inspection and inserts.
      // Fixed lock ordering avoids deadlock between overlapping packet imports.
      for (const table of [...packet.tables].sort((a, b) => a.table.localeCompare(b.table))) {
        await db.query(`LOCK TABLE public.${quoted(table.table)} IN SHARE ROW EXCLUSIVE MODE`);
      }
      for (const table of packet.tables) {
        if (JSON.stringify(await inspect(db, table.table)) !== JSON.stringify(table.columns)) fail("schema_conflict", table.table);
        const triggers = (await db.query(`SELECT 1 FROM pg_catalog.pg_trigger
          WHERE tgrelid=$1::regclass AND NOT tgisinternal AND (tgtype & 4) <> 0 AND tgenabled IN ('O','A')`, [`public.${table.table}`])).rows;
        if (triggers.length) fail("insert_trigger_requires_owner", table.table);
      }
      let inserted = 0, replayed = 0;
      for (const table of packet.tables) {
        const name = `public.${quoted(table.table)}`;
        const columns = table.columns.map(column => quoted(column.name)).join(",");
        const keys = table.columns.filter(column => column.key).map(column => `t.${quoted(column.name)} IS NOT DISTINCT FROM p.${quoted(column.name)}`).join(" AND ");
        for (const row of table.rows) {
          const write = await db.query(`INSERT INTO ${name} (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::${name}, $1::jsonb)
            ON CONFLICT DO NOTHING RETURNING 1 AS inserted`, [row]);
          const read = await db.query<{ identical: boolean }>(`SELECT to_jsonb(t) = $1::jsonb AS identical FROM ${name} t,
            jsonb_populate_record(NULL::${name}, $1::jsonb) p WHERE ${keys}`, [row]);
          if (read.rows.length !== 1 || read.rows[0]?.identical !== true) fail("target_conflict", table.table);
          if (write.rows.length) inserted++; else replayed++;
        }
      }
      return { inserted, replayed, sha256: packet.sha256 };
    });
  } catch (error) { throw redacted(error); }
}

async function inspect(db: TransferPostgresQuery, table: CompatiblePostgresTable): Promise<Column[]> {
  const rows = (await db.query<{ name: string; type: string; key: boolean; generated: string; identity: string }>(`SELECT a.attname AS name,
    pg_catalog.format_type(a.atttypid,a.atttypmod) AS type, COALESCE(a.attnum = ANY(i.indkey),false) AS key,
    a.attgenerated AS generated, a.attidentity AS identity
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    LEFT JOIN pg_catalog.pg_index i ON i.indrelid=c.oid AND i.indisprimary
    WHERE a.attrelid=$1::regclass AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [`public.${table}`])).rows;
  if (!rows.length || !rows.some(row => row.key) || rows.some(row => row.generated || row.identity || !identifier(row.name))) fail("schema_conflict", table);
  return rows.map(({ name, type, key }) => ({ name, type, key }));
}
function tableNames(tables: readonly CompatiblePostgresTable[]): CompatiblePostgresTable[] {
  if (!Array.isArray(tables) || !tables.length || new Set(tables).size !== tables.length) fail("invalid_input");
  for (const table of tables) if (!(TABLES as readonly string[]).includes(table)) fail("unsupported_table");
  return TABLES.filter(table => tables.includes(table));
}
function validatePacket(packet: CompatiblePostgresPacket): void {
  if (!packet || packet.format !== "openlup.compatible-rows.v1" || !identity(packet.sourceId) || !identity(packet.catalogueId)
    || !Array.isArray(packet.tables) || !/^[a-f0-9]{64}$/.test(packet.sha256)) fail("invalid_input");
  const { sha256: _hash, ...payload } = packet;
  if (digest(payload) !== packet.sha256) fail("invalid_input");
  const names = tableNames(packet.tables.map(table => table.table));
  if (names.some((name, index) => name !== packet.tables[index]?.table)) fail("invalid_input");
  let count = 0, bytes = 0;
  for (const table of packet.tables) {
    if (!Array.isArray(table.columns) || !table.columns.length || !table.columns.some(column => column.key)
      || table.columns.some(column => !identifier(column.name) || !identity(column.type) || typeof column.key !== "boolean")
      || new Set(table.columns.map(column => column.name)).size !== table.columns.length || !Array.isArray(table.rows)) fail("invalid_input");
    for (const row of table.rows) {
      if (typeof row !== "string") fail("invalid_input");
      // Inspect only field names. Never stringify parsed values back to SQL.
      const parsed: unknown = JSON.parse(row);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || Object.keys(parsed).sort().join("\0") !== table.columns.map(column => column.name).sort().join("\0")) fail("invalid_input");
      count++; bytes += Buffer.byteLength(row);
    }
  }
  if (count > LIMIT_ROWS || bytes > LIMIT_BYTES) fail("limit_exceeded");
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function identifier(value: string): boolean { return /^[a-z][a-z0-9_]{0,62}$/.test(value); }
function quoted(value: string): string { if (!identifier(value)) fail("invalid_input"); return `"${value}"`; }
function identity(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 1024
  && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127); }
function ceiling(value: number, maximum: number): boolean { return Number.isSafeInteger(value) && value > 0 && value <= maximum; }
function fail(code: PostgresTransferFailure, table?: string): never { throw new PostgresTransferError(code, table); }
function redacted(error: unknown): PostgresTransferError { return error instanceof PostgresTransferError ? error : new PostgresTransferError("database_unavailable"); }
