import { createHash } from "node:crypto";
import {
  captureCompatiblePostgresRows, PostgresTransferError,
  type CompatiblePostgresPacket, type CompatiblePostgresSnapshot, type CompatiblePostgresTable,
} from "@openlup/platform/portability";

// One finite native subscription/order/media profile. This is not an extension
// registry or a caller-selected SQL/table importer. Unknown nonempty public/app
// data refuses the whole capture; credentials and migration history are not data
// to copy. Changing this set requires its domain/identity/operations owner read.
const compatible = [
  "clients", "subscriptions", "subscription_events", "subscription_pause_windows",
  "subscription_renewal_terms", "subscription_renewal_term_lines", "subscription_renewal_operations",
  "subscription_cycles", "commerce_orders", "commerce_order_items", "commerce_settlement_intents",
  "commerce_settlement_transitions", "payment_truth_events", "payment_truth_reconciliation_evidence",
  "subscription_renewal_outcomes", "outbox_events", "invoicing_duties", "invoicing_fact_revisions",
  "invoicing_effect_receipts", "invoicing_capture_faults",
] as const satisfies readonly CompatiblePostgresTable[];

const owned = [
  "platform_human_principals", "platform_human_memberships", "platform_human_membership_audit_events",
  "catalog_products", "catalog_skus", "price_lists", "price_entries", "subscription_lines",
  "communication_recipient_consents", "communication_native_sends", "communication_native_observations", "communication_native_sync_state",
  "identity_operator_invitations", "identity_operator_invitation_events", "identity_privacy_erasures",
  "customer_subject_lifecycle_events", "customer_communication_preferences", "customer_communication_preference_events",
  "commerce_operators", "commerce_order_holds", "commerce_order_operations",
  "fulfillment_provider_archetypes", "fulfillment_ports", "fulfillment_shipments", "shipment_external_refs", "fulfillment_shipment_operations",
  "fulfillment_provider_attempts", "commerce_fulfillment_provider_commands", "commerce_fulfillment_provider_command_transitions",
  "fulfillment_dispatch_contexts", "fulfillment_dispatch_refs", "fulfillment_paid_handoffs", "fulfillment_observations", "fulfillment_stock_movements",
  "subscription_delivery_alignment_cases", "subscription_delivery_alignment_admission_receipts", "subscription_delivery_alignment_arrivals",
  "subscriber_profiles", "subscriber_review_access_grants", "subscriber_retention_intents",
  "commerce_order_reviews", "commerce_order_review_media", "commerce_order_review_command_receipts", "commerce_order_review_audit",
  "invoicing_cutover", "invoicing_document_observations", "invoicing_delivery_receipts", "invoicing_seller_revisions",
  "platform_communication_operators", "platform_control_operators", "platform_operational_controls", "platform_control_operations",
  "platform_alerts", "platform_alert_notifications", "platform_job_controls", "platform_job_runs",
  "sales_channels", "commerce_settings", "client_absorption_policy", "subscriber_retention_activation_watermarks",
  "subscription_delivery_alignment_control", "outbox_dormant_event_types",
] as const;

export const connectedNativeStoreTables = [...compatible, ...owned] as const;

type OwnedTable = typeof owned[number];
type Column = { name: string; type: string };
export interface ConnectedStoreOwnedRows {
  table: OwnedTable;
  columns: Column[];
  rows: string[];
}
export interface ConnectedNativeStoreCapture {
  format: "openlup.native-retained-store.v1";
  compatible: CompatiblePostgresPacket;
  owned: ConnectedStoreOwnedRows[];
  /** Actual database snapshot identity; never an object/host seal receipt. */
  observation: { cluster: string; database: string; login: string; snapshot: string };
  emptyOutsideProfile: string[];
  outsideProfileCensus: { relation: string; owner: string; rows: string;
    disposition: "unsupported-empty" | "new-target-installation-key" | "target-migration-history" }[];
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
      }>(`SELECT pg_catalog.current_setting('transaction_read_only') AS readonly,
        pg_catalog.current_setting('transaction_isolation') AS isolation,
        ${connectedStoreClusterIdentitySql} AS cluster,
        pg_catalog.current_database() AS database, session_user::pg_catalog.text AS login,
        pg_catalog.txid_current_snapshot()::pg_catalog.text AS snapshot`)).rows[0];
      if (facts?.readonly !== "on" || facts.isolation !== "repeatable read") throw new PostgresTransferError("invalid_input");
      // A login that row security would filter must fail here, not read an empty source.
      await db.query("SET LOCAL row_security = off");
      await db.query("SET LOCAL TimeZone = 'UTC'");
      // Existing utility validates source IDs, limits, schema and lossless rows;
      // its callback reuses this held client without another BEGIN/COMMIT.
      const packet = await captureCompatiblePostgresRows({
        source: { withSnapshot: work => work(db) }, sourceId, catalogueId,
        tables: compatible, maximumRows, maximumBytes,
      });
      const relations = (await db.query<{ schema: string; table: string; owner: string }>(`SELECT n.nspname AS schema,c.relname AS table,
        pg_catalog.pg_get_userbyid(c.relowner) AS owner
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE pg_catalog.left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
        AND c.relkind IN ('r','p') ORDER BY n.nspname,c.relname`)).rows;
      const allowed = new Set<string>([...compatible, ...owned]);
      const emptyOutsideProfile: string[] = [];
      const outsideProfileCensus: ConnectedNativeStoreCapture["outsideProfileCensus"] = [];
      for (const relation of relations) {
        if (relation.schema === "public" && allowed.has(relation.table)) continue;
        const qualified = `${identifier(relation.schema)}.${identifier(relation.table)}`;
        if (relation.schema === "acquisition_private" && relation.table === "installation_key"
          || relation.schema === "public" && relation.table === "platform_schema_migrations") {
          // Count/ownership only. Never read, hash or transport installation key
          // payloads. Private acquisition business rows below are NOT secrets
          // by naming convention: nonempty cases/history still refuse capture.
          const rows = (await db.query<{ count: string }>(`SELECT count(*)::pg_catalog.text AS count FROM ${qualified}`)).rows[0]!.count;
          outsideProfileCensus.push({ relation: `${relation.schema}.${relation.table}`, owner: relation.owner, rows,
            disposition: relation.table === "installation_key" ? "new-target-installation-key" : "target-migration-history" });
          continue;
        }
        if ((await db.query(`SELECT 1 FROM ${qualified} LIMIT 1`)).rows.length) {
          throw new PostgresTransferError("unsupported_table", `${relation.schema}.${relation.table}`);
        }
        emptyOutsideProfile.push(`${relation.schema}.${relation.table}`);
        outsideProfileCensus.push({ relation: `${relation.schema}.${relation.table}`, owner: relation.owner, rows: "0", disposition: "unsupported-empty" });
      }
      let count = packet.tables.reduce((sum, table) => sum + table.rows.length, 0);
      let bytes = packet.tables.reduce((sum, table) => sum + table.rows.reduce((total, row) => total + Buffer.byteLength(row), 0), 0);
      const tables: ConnectedStoreOwnedRows[] = [];
      for (const table of owned) {
        const columns = (await db.query<Column>(`SELECT a.attname AS name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type
          FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
          WHERE a.attrelid=$1::pg_catalog.regclass AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
          ORDER BY a.attnum`, [`public.${table}`])).rows;
        if (!columns.length || columns.some(column => !/^[a-z][a-z0-9_]{0,62}$/.test(column.name))) {
          throw new PostgresTransferError("schema_conflict", table);
        }
        // Only PostgreSQL encodes row values. JS never reserializes parsed
        // bigint/numeric/timestamp values for transport.
        const rows = (await db.query<{ value: string }>(`SELECT pg_catalog.to_jsonb(t)::pg_catalog.text AS value
          FROM public.${identifier(table)} t ORDER BY pg_catalog.to_jsonb(t)::pg_catalog.text LIMIT $1`, [maximumRows + 1])).rows.map(row => row.value);
        count += rows.length;
        bytes += rows.reduce((sum, row) => sum + Buffer.byteLength(row), 0);
        if (count > maximumRows || bytes > maximumBytes) throw new PostgresTransferError("limit_exceeded", table);
        tables.push({ table, columns, rows });
      }
      const result = {
        format: "openlup.native-retained-store.v1" as const,
        compatible: packet, owned: tables,
        observation: { cluster: facts.cluster, database: facts.database, login: facts.login, snapshot: facts.snapshot }, emptyOutsideProfile, outsideProfileCensus,
      };
      return { ...result, sha256: createHash("sha256").update(JSON.stringify(result)).digest("hex") };
    });
  } catch (error) {
    if (error instanceof PostgresTransferError) throw error;
    throw new PostgresTransferError("database_unavailable");
  }
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new PostgresTransferError("invalid_input");
  return `"${value}"`;
}
