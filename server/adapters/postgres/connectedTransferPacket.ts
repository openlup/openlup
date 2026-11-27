import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { validateRequiredPrivacyContributorIds } from "@openlup/platform/identity";
import { PostgresTransferError } from "@openlup/platform/portability";
import { connectedNativeStoreTables, type ConnectedNativeStoreCapture } from "./connectedStoreCapture.js";
import { connectedStoreOutsideProfileRelations } from "./connectedStoreDomains/index.js";

export type ConnectedStoreTableName = typeof connectedNativeStoreTables[number];
export type ConnectedStoreTableRows = {
  table: ConnectedStoreTableName;
  columns: readonly { name: string; type: string }[];
  rows: readonly string[];
};
export type ConnectedStoreSourceShape = "current" | "unsupported";

export interface RelationQueryClient {
  query<Row extends { schema: string; table: string }>(sql: string): Promise<{ rows: readonly Row[] }>;
}

export interface ReplaceTargetRowsOptions {
  quoteIdentifier: (value: string) => string;
  columnMismatchCode: "invalid_input" | "schema_conflict";
  includeTableOnInputError?: boolean;
}

export function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function quoteRestoreIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new PostgresTransferError("invalid_input");
  return `"${value}"`;
}

export function rehashCapturePacket(packet: ConnectedNativeStoreCapture): void {
  const { sha256: _inner, ...inner } = packet.compatible;
  packet.compatible.sha256 = digest(JSON.stringify(inner));
  const { sha256: _outer, ...outer } = packet;
  packet.sha256 = digest(JSON.stringify(outer));
}

export async function listUserRelations(
  client: RelationQueryClient,
): Promise<readonly { schema: string; table: string }[]> {
  return (await client.query<{ schema: string; table: string }>(`SELECT n.nspname AS schema,c.relname AS table
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE pg_catalog.left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
      AND c.relkind IN ('r','p')
    ORDER BY n.nspname,c.relname`)).rows;
}

export async function replaceTargetRows(
  packet: ConnectedNativeStoreCapture,
  table: string,
  rows: readonly Record<string, unknown>[],
  owner: Pool,
  options: ReplaceTargetRowsOptions,
): Promise<void> {
  const held = packet.compatible.tables.find(value => value.table === table)
    ?? packet.owned.find(value => value.table === table);
  if (!held || held.rows.length) throw new PostgresTransferError("target_conflict", table);
  const columns = held.columns.map(column => column.name);
  const normalized: string[] = [];
  const inputErrorTable = options.includeTableOnInputError ? table : undefined;
  for (const row of rows) {
    if (Object.keys(row).sort().join("\0") !== [...columns].sort().join("\0")) {
      throw new PostgresTransferError(
        options.columnMismatchCode,
        options.columnMismatchCode === "schema_conflict" ? table : inputErrorTable,
      );
    }
    try {
      // Restore compares this text at UTC, so a target session in another zone must not format it.
      const result = await owner.query<{ value: string }>(
        `SELECT pg_catalog.set_config('TimeZone','UTC',true) AS zone,pg_catalog.to_jsonb(p)::pg_catalog.text AS value
        FROM pg_catalog.jsonb_populate_record(NULL::public.${options.quoteIdentifier(table)},$1::jsonb) p`,
        [JSON.stringify(row)],
      );
      if (result.rows.length !== 1) throw new PostgresTransferError("invalid_input", inputErrorTable);
      normalized.push(result.rows[0]!.value);
    } catch (error) {
      if (error instanceof PostgresTransferError) throw error;
      if (typeof (error as { code?: unknown })?.code === "string" && /^2[23]/.test((error as { code: string }).code)) {
        throw new PostgresTransferError("invalid_input", inputErrorTable);
      }
      throw error;
    }
  }
  held.rows = normalized.sort();
}

export function refuseSourceSchema(table?: ConnectedStoreTableName): never {
  const error = new PostgresTransferError("schema_conflict", table);
  const remedy = "capture the source and restore it with the same OpenLup version on a pristine target of the same profile; upgrade the source within its installed profile first if it is older";
  error.message += ` (${remedy})`;
  throw Object.assign(error, { remedy });
}

export function captureTables(packet: ConnectedNativeStoreCapture): Map<ConnectedStoreTableName, ConnectedStoreTableRows> {
  const all: ConnectedStoreTableRows[] = [...packet.compatible.tables, ...packet.owned];
  if (new Set(all.map(table => table.table)).size !== all.length) throw new PostgresTransferError("invalid_input");
  return new Map<ConnectedStoreTableName, ConnectedStoreTableRows>(all.map(table => [table.table, table]));
}

export function copyCapture(
  input: ConnectedNativeStoreCapture,
  shape: ConnectedStoreSourceShape = "current",
): ConnectedNativeStoreCapture {
  try {
    const copy = JSON.parse(JSON.stringify(input)) as ConnectedNativeStoreCapture;
    const { sha256, ...body } = copy;
    if (copy.format !== "openlup.native-retained-store.v1" || digest(JSON.stringify(body)) !== sha256) {
      throw new PostgresTransferError("invalid_input");
    }
    if (!copy.observation || Object.keys(copy.observation).sort().join("\0") !== "cluster\0database\0login\0snapshot"
      || Object.values(copy.observation).some(value => typeof value !== "string" || !value)) {
      throw new PostgresTransferError("invalid_input");
    }
    if (!Array.isArray(copy.outsideProfileCensus)) throw new PostgresTransferError("invalid_input");
    for (const entry of copy.outsideProfileCensus) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || Object.keys(entry).sort().join("\0") !== "disposition\0owner\0relation\0rows"
        || typeof entry.relation !== "string" || !entry.relation || typeof entry.owner !== "string" || !entry.owner
        || typeof entry.rows !== "string" || !entry.rows || /[^0-9]/.test(entry.rows)) {
        throw new PostgresTransferError("invalid_input");
      }
      const disposition = connectedStoreOutsideProfileRelations.get(entry.relation)?.disposition ?? "unsupported-empty";
      if (entry.disposition !== disposition || disposition === "unsupported-empty" && entry.rows !== "0") {
        throw new PostgresTransferError("invalid_input");
      }
    }
    if (shape === "unsupported") refuseSourceSchema();
    validateRequiredPrivacyContributorIds(copy.requiredPrivacyContributorIds);
    const all = captureTables(copy);
    if (all.size !== connectedNativeStoreTables.length || connectedNativeStoreTables.some(table => !all.has(table))) {
      throw new PostgresTransferError("invalid_input");
    }
    let count = 0, bytes = 0;
    for (const table of all.values()) {
      for (const column of table.columns) quoteRestoreIdentifier(column.name);
      if (!table.columns.length || new Set(table.columns.map(column => column.name)).size !== table.columns.length) {
        throw new PostgresTransferError("invalid_input");
      }
      for (const row of table.rows) {
        const value = JSON.parse(row) as Record<string, unknown>;
        if (table.table === "identity_privacy_erasure_reconciliations" && !isPrivacyApprovalRow(value)) {
          throw new PostgresTransferError("invalid_input", table.table);
        }
        if (!value || Array.isArray(value)
          || Object.keys(value).sort().join("\0") !== table.columns.map(column => column.name).sort().join("\0")) {
          throw new PostgresTransferError("invalid_input");
        }
        count++; bytes += Buffer.byteLength(row);
      }
    }
    if (count > 10000 || bytes > 64 * 1024 * 1024) throw new PostgresTransferError("limit_exceeded");
    return copy;
  } catch (error) {
    if (error instanceof PostgresTransferError) throw error;
    throw new PostgresTransferError("invalid_input");
  }
}

function isPrivacyApprovalRow(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== "contributor_id\0erasure_id\0evidence_ref") return false;
  const { contributor_id, erasure_id, evidence_ref } = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  return typeof contributor_id === "string" && /^[a-z][a-z0-9.-]{0,99}$/u.test(contributor_id)
    && typeof erasure_id === "string" && uuid.test(erasure_id) && typeof evidence_ref === "string" && uuid.test(evidence_ref);
}
