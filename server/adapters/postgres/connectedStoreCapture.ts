import { nativeCatalogPublication } from "@openlup/platform/catalog";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { readRequiredPrivacyContributorIds, validateRequiredPrivacyContributorIds } from "@openlup/platform/identity";
import { createHash } from "node:crypto";
import {
  captureCompatiblePostgresRows, PostgresTransferError,
  type CompatiblePostgresPacket, type CompatiblePostgresSnapshot, type CompatiblePostgresTable,
} from "@openlup/platform/portability";
import { connectedStoreOutsideProfileRelations, connectedStoreOwnedTables as owned,
  type ConnectedStoreOutsideProfileDisposition } from "./connectedStoreDomains/index.js";
import { renewalUpgradeCohort, tablesForRenewalUpgradeCohort } from "./connectedStoreDomains/subscriptions.js";

const { catalogPublicationAdmissionRefusal, assertPublishedSkuIdentity, decodePublicationPacket, requireDecodedPublication } = nativeCatalogPublication;

export async function assertConnectedCatalogPublications(db: PgQueryExecutor) {
  await assertPublishedSkuIdentity(db);
  // Verify the live projections against the sealed dialect, including the governed option identity.
  await db.query(`SELECT count(public.catalog_publication_product_facts(id,publication_facts,true))
    FROM public.catalog_products WHERE publication_facts IS NOT NULL`);
  await db.query(`SELECT count(public.catalog_publication_sku_projection(id,product_id,sku,publication_facts,true))
    FROM public.catalog_skus WHERE publication_facts IS NOT NULL`);
  await db.query(`SELECT public.catalog_publication_assert_issued(p.product_id,p.id)
    FROM public.catalog_publications p`);
  await db.query(`SELECT public.catalog_publication_assert_receipt(r.scope_id,r.command_key)
    FROM public.catalog_operator_receipts r`);
  await db.query(`SELECT public.catalog_publication_assert_candidate(d,NULL,NULL)
    FROM public.catalog_publication_decisions d`);
  await db.query(`SELECT public.catalog_publication_assert_head(h.product_id,true)
    FROM public.catalog_publication_heads h`);
}

// One finite native subscription/order/media profile. This is not an extension
// registry or a caller-selected SQL/table importer. Unknown nonempty public/app
// data refuses the whole capture; credentials and migration history are not data
// to copy. Changing this set requires its domain/identity/operations owner read.
const compatible = [
  "clients", "subscriptions", "subscription_events", "subscription_pause_windows",
  "subscription_renewal_terms", "subscription_renewal_term_lines", "subscription_renewal_operations",
  "subscription_cycles", "commerce_orders", "commerce_order_items",
  // Authoritative short-lived admission state. Digests and original epoch times stay private.
  "commerce_checkout_attempt_ledger", "commerce_settlement_intents",
  "commerce_settlement_transitions", "payment_truth_events", "payment_truth_reconciliation_evidence",
  "subscription_renewal_outcomes", "outbox_events", "invoicing_duties", "invoicing_fact_revisions",
  "invoicing_effect_receipts", "invoicing_capture_faults",
] as const satisfies readonly CompatiblePostgresTable[];

export const requiredPrivacyDeclarationTable = "identity_privacy_required_contributors";

export async function readPrivacyDeclarationCensus(db: PgQueryExecutor): Promise<readonly string[]> {
  try { return validateRequiredPrivacyContributorIds(await readRequiredPrivacyContributorIds(db)); }
  catch { throw new PostgresTransferError("schema_conflict", requiredPrivacyDeclarationTable); }
}

export const connectedNativeStoreTables = [...compatible, ...owned] as const;

type OwnedTable = typeof owned[number];
type Column = { name: string; type: string };
const documentRevisionColumns = new Set([
  "id", "product_id", "revision_no", "schema_id", "document_ref", "document_payload",
  "source_ref", "provenance", "digest", "created_at",
]);

// Capture and restore use the same closed document projection to compare the
// packet's PostgreSQL encoding.
export function connectedStoreRowSource(table: string, columns: readonly Column[]): string {
  if (table !== "catalog_product_document_revisions") return `public.${identifier(table)}`;
  if (columns.some(column => !documentRevisionColumns.has(column.name))) throw new PostgresTransferError("schema_conflict", table);
  return `(SELECT ${columns.map(column => identifier(column.name)).join(",")} FROM public.catalog_product_document_revisions)`;
}

export interface ConnectedStoreOwnedRows {
  table: OwnedTable;
  columns: Column[];
  rows: string[];
}
export interface ConnectedNativeStoreCapture {
  format: "openlup.native-retained-store.v1";
  compatible: CompatiblePostgresPacket;
  owned: ConnectedStoreOwnedRows[];
  requiredPrivacyContributorIds: readonly string[];
  /** Actual database snapshot identity; never an object/host seal receipt. */
  observation: { cluster: string; database: string; login: string; snapshot: string };
  emptyOutsideProfile: string[];
  outsideProfileCensus: { relation: string; owner: string; rows: string;
    disposition: "unsupported-empty" | ConnectedStoreOutsideProfileDisposition }[];
  sha256: string;
}

// Ordinary PostgreSQL sessions can observe this database incarnation. A
// postmaster restart changes the value and requires a new pristine capture.
// The database name is checked separately by connected restore.
export const connectedStoreClusterIdentitySql = String.raw`pg_catalog.concat_ws(':',
  pg_catalog.date_part('epoch', pg_catalog.pg_postmaster_start_time())::pg_catalog.text,
  pg_catalog.inet_server_addr()::pg_catalog.text,
  pg_catalog.inet_server_port()::pg_catalog.text,
  (SELECT oid::pg_catalog.text FROM pg_catalog.pg_database
    WHERE datname OPERATOR(pg_catalog.=) pg_catalog.current_database()))`;

/**
 * Capture the selected finite native graph in ONE observed read-only repeatable
 * read transaction. The actual host must separately exclude all DB/object
 * writers and reconcile filesystem/access state; no callback/label here attests
 * that exclusion or establishes canonical installation qualification.
 */
export async function captureConnectedNativeStore(input: {
  source: CompatiblePostgresSnapshot;
  sourceId: string;
  catalogueId: string;
  maximumRows: number;
  maximumBytes: number;
}): Promise<ConnectedNativeStoreCapture> {
  const { source, sourceId, catalogueId, maximumRows, maximumBytes } = input;
  try {
    return await source.withSnapshot(async db => {
      const facts = (await db.query<{
        readonly: string; isolation: string; cluster: string; database: string; login: string; snapshot: string;
        renewal_cohort_installed: boolean;
      }>(`SELECT pg_catalog.current_setting('transaction_read_only') AS readonly,
        pg_catalog.current_setting('transaction_isolation') AS isolation,
        ${connectedStoreClusterIdentitySql} AS cluster,
        pg_catalog.current_database() AS database, session_user::pg_catalog.text AS login,
        pg_catalog.txid_current_snapshot()::pg_catalog.text AS snapshot,
        EXISTS (SELECT 1 FROM public.platform_schema_migrations WHERE catalog_path ~ $1) AS renewal_cohort_installed`,
      [renewalUpgradeCohort.forward.source])).rows[0];
      if (facts?.readonly !== "on" || facts.isolation !== "repeatable read") throw new PostgresTransferError("invalid_input");
      const ownedTables = tablesForRenewalUpgradeCohort(owned, facts.renewal_cohort_installed);
      // A login that row security would filter must fail here, not read an empty source.
      await db.query("SET LOCAL row_security = off");
      await db.query("SET LOCAL TimeZone = 'UTC'");
      // Existing utility validates source IDs, limits, schema and lossless rows;
      // its callback reuses this held client without another BEGIN/COMMIT.
      const packet = await captureCompatiblePostgresRows({
        source: { async withSnapshot(work) {
          const { rows: [relation] } = await db.query<{ present: boolean }>(
            "SELECT pg_catalog.to_regclass('public.catalog_subscription_profile_receipts') IS NOT NULL AS present");
          if (relation?.present) {
            const { rows: [receipts] } = await db.query<{ present: boolean }>(
              "SELECT EXISTS (SELECT 1 FROM public.catalog_subscription_profile_receipts) AS present");
            if (receipts?.present) {
              throw Object.assign(new PostgresTransferError(
                "subscription_profile_receipts_unsupported", "catalog_subscription_profile_receipts"), {
                remedy: "Wait for connected-store restore support for subscription profile receipts (RS-1).",
              });
            }
          }
          return work(db);
        } }, sourceId, catalogueId,
        tables: compatible, maximumRows, maximumBytes,
      });
      const requiredPrivacyContributorIds = await readPrivacyDeclarationCensus(db);
      const relations = (await db.query<{ schema: string; table: string; owner: string }>(`SELECT n.nspname AS schema,c.relname AS table,
        pg_catalog.pg_get_userbyid(c.relowner) AS owner
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE pg_catalog.left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
        AND c.relkind IN ('r','p') ORDER BY n.nspname,c.relname`)).rows;
      const cohortPresent = relations.some(relation => relation.schema === "public" && relation.table === renewalUpgradeCohort.table);
      if (cohortPresent !== facts.renewal_cohort_installed) throw new PostgresTransferError("schema_conflict", renewalUpgradeCohort.table);
      const allowed = new Set<string>([...compatible, ...ownedTables]);
      const emptyOutsideProfile: string[] = [];
      const outsideProfileCensus: ConnectedNativeStoreCapture["outsideProfileCensus"] = [];
      for (const relation of relations) {
        if (relation.schema === "public" && (allowed.has(relation.table) || relation.table === requiredPrivacyDeclarationTable)) continue;
        const qualified = `${identifier(relation.schema)}.${identifier(relation.table)}`;
        const relationName = `${relation.schema}.${relation.table}`;
        const census = connectedStoreOutsideProfileRelations.get(relationName);
        if (census) {
          // Registered outside-profile relations contribute count and ownership only.
          const rows = (await db.query<{ count: string }>(`SELECT count(*)::pg_catalog.text AS count FROM ${qualified}`)).rows[0]!.count;
          outsideProfileCensus.push({ relation: relationName, owner: relation.owner, rows, disposition: census.disposition });
          continue;
        }
        if ((await db.query(`SELECT 1 FROM ${qualified} LIMIT 1`)).rows.length) {
          throw new PostgresTransferError("unsupported_table", relationName);
        }
        emptyOutsideProfile.push(relationName);
        outsideProfileCensus.push({ relation: relationName, owner: relation.owner, rows: "0", disposition: "unsupported-empty" });
      }
      let count = packet.tables.reduce((sum, table) => sum + table.rows.length, 0);
      let bytes = packet.tables.reduce((sum, table) => sum + table.rows.reduce((total, row) => total + Buffer.byteLength(row), 0), 0);
      const columnsByTable = new Map<string, Column[]>();
      const { rows: attributeRows } = await db.query<{ table: string; name: string | null; type: string | null }>(`SELECT c.relname AS table,a.attname AS name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
        WHERE n.nspname='public' AND c.relname=ANY($1::pg_catalog.text[])
        ORDER BY c.relname,a.attnum`, [ownedTables]);
      for (const row of attributeRows) {
        const columns = columnsByTable.get(row.table) ?? [];
        if (row.name !== null && row.type !== null) columns.push({ name: row.name, type: row.type });
        columnsByTable.set(row.table, columns);
      }
      const tables: ConnectedStoreOwnedRows[] = [];
      for (const table of ownedTables) {
        const columns = columnsByTable.get(table);
        // Preserve the redacted failure from the previous regclass lookup.
        if (!columns) throw new PostgresTransferError("database_unavailable");
        if (!columns.length || columns.some(column => !/^[a-z][a-z0-9_]{0,62}$/.test(column.name))) {
          throw new PostgresTransferError("schema_conflict", table);
        }
        // Only PostgreSQL encodes row values. JS never reserializes parsed
        // bigint/numeric/timestamp values for transport.
        const rows = (await db.query<{ value: string }>(`SELECT pg_catalog.to_jsonb(t)::pg_catalog.text AS value
          FROM ${connectedStoreRowSource(table, columns)} t ORDER BY pg_catalog.to_jsonb(t)::pg_catalog.text LIMIT $1`, [maximumRows + 1])).rows.map(row => row.value);
        count += rows.length;
        bytes += rows.reduce((sum, row) => sum + Buffer.byteLength(row), 0);
        if (count > maximumRows || bytes > maximumBytes) throw new PostgresTransferError("limit_exceeded", table);
        tables.push({ table, columns, rows });
      }
      requireDecodedPublication(decodePublicationPacket({
        publications: tables.find(table => table.table === "catalog_publications")!.rows,
        skuRevisions: tables.find(table => table.table === "catalog_sku_revisions")!.rows,
      }));
      await assertConnectedCatalogPublications(db);
      const result = {
        format: "openlup.native-retained-store.v1" as const,
        compatible: packet, owned: tables, requiredPrivacyContributorIds,
        observation: { cluster: facts.cluster, database: facts.database, login: facts.login, snapshot: facts.snapshot }, emptyOutsideProfile, outsideProfileCensus,
      };
      return { ...result, sha256: createHash("sha256").update(JSON.stringify(result)).digest("hex") };
    });
  } catch (error) {
    if (error instanceof PostgresTransferError) throw error;
    const refusal = catalogPublicationAdmissionRefusal(error);
    if (refusal) throw Object.assign(new PostgresTransferError("target_conflict"), { cause: refusal });
    throw new PostgresTransferError("database_unavailable");
  }
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new PostgresTransferError("invalid_input");
  return `"${value}"`;
}
