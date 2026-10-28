import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  PostgresTransferError, restoreCompatiblePostgresRows,
  type CompatiblePostgresPacket,
} from "@openlup/platform/portability";
import { evaluatePlatformMigrationManifest, readPlatformMigrationManifest, readPlatformMigrations, selectPlatformMigrationManifest, type PlatformMigrationManifest } from "../../../scripts/platform-migration-manifest.js";
import { qualifiedPostgresCatalogPayload, type QualifiedPostgresInstallation } from "./qualifiedInstall.js";
import { connectedNativeStoreTables, type ConnectedNativeStoreCapture } from "./connectedStoreCapture.js";

type TableName = typeof connectedNativeStoreTables[number];
type Rows = { table: TableName; columns: readonly { name: string; type: string }[]; rows: readonly string[] };
const migrationLock = "openlup:public-platform-migrations:v1";
const settings = ["fulfillment_provider_archetypes", "sales_channels", "commerce_settings", "client_absorption_policy",
  "platform_job_controls", "subscriber_retention_activation_watermarks", "subscription_delivery_alignment_control"] as const;
type SettingsTable = typeof settings[number];

// Explicit owner order, not schema discovery or a general FK/translation engine.
const order = [
  "platform_human_principals", "platform_control_operators", "commerce_operators", "clients",
  "platform_human_memberships", "platform_human_membership_audit_events", "platform_communication_operators",
  "identity_operator_invitations", "identity_operator_invitation_events", "identity_privacy_erasures",
  "customer_subject_lifecycle_events", "customer_communication_preferences", "customer_communication_preference_events",
  "platform_operational_controls", "platform_control_operations", "platform_alerts", "platform_alert_notifications", "platform_job_runs",
  "subscriptions", "subscription_events", "subscription_pause_windows", "subscription_renewal_terms", "subscription_renewal_term_lines",
  "subscription_renewal_operations", "subscription_cycles", "commerce_orders", "commerce_order_items",
  "commerce_settlement_intents", "commerce_settlement_transitions",
  "payment_truth_events", "payment_truth_reconciliation_evidence", "subscription_renewal_outcomes", "outbox_events", "outbox_dormant_event_types",
  "fulfillment_ports", "fulfillment_shipments", "shipment_external_refs", "fulfillment_shipment_operations", "fulfillment_provider_attempts",
  "commerce_fulfillment_provider_commands", "commerce_fulfillment_provider_command_transitions", "fulfillment_dispatch_contexts",
  "fulfillment_dispatch_refs", "fulfillment_paid_handoffs", "fulfillment_observations", "fulfillment_stock_movements",
  "commerce_order_holds", "commerce_order_operations", "subscription_delivery_alignment_cases", "subscription_delivery_alignment_admission_receipts", "subscription_delivery_alignment_arrivals",
  "subscriber_profiles", "subscriber_review_access_grants", "subscriber_retention_intents", "commerce_order_reviews", "commerce_order_review_media",
  "commerce_order_review_command_receipts", "commerce_order_review_audit", "invoicing_cutover", "invoicing_duties", "invoicing_seller_revisions",
  "invoicing_fact_revisions", "invoicing_effect_receipts", "invoicing_capture_faults", "invoicing_document_observations", "invoicing_delivery_receipts",
] as const satisfies readonly TableName[];

/**
 * One finite native-profile owner transaction. The host must actually own a
 * newly installed target, its pristine capture and exclusion of every target
 * writer/dispatcher. A supplied capture binds expected data; it does not certify
 * that host prerequisite. No user route, role grant or target activation exists.
 * Source and target must use the same qualified catalogue binding shape.
 */
export async function restoreConnectedNativeStore(input: {
  owner: Pool;
  installation: QualifiedPostgresInstallation;
  packet: ConnectedNativeStoreCapture;
  freshTarget: ConnectedNativeStoreCapture;
}): Promise<{ captureSha256: string; replayed: boolean; neutralizedHistoricalHoldNotifications: number }> {
  const packet = copyCapture(input.packet), fresh = copyCapture(input.freshTarget);
  const installation = { ...input.installation };
  const source = tables(packet), baseline = tables(fresh);
  const client = await input.owner.connect().catch(() => { throw new PostgresTransferError("database_unavailable"); });
  let locked = false, unlockFailed = false;
  let result: { captureSha256: string; replayed: boolean; neutralizedHistoricalHoldNotifications: number } | undefined;
  try {
    await client.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1,0))", [migrationLock]);
    locked = true;
    await client.query("BEGIN");
    await client.query("SET LOCAL TimeZone = 'UTC'");
    const facts = (await client.query<{ cluster: string; database: string; login: string; xid: string; mode: string }>(`SELECT
      (SELECT system_identifier::pg_catalog.text FROM pg_catalog.pg_control_system()) AS cluster,
      pg_catalog.current_database() AS database,session_user::pg_catalog.text AS login,
      pg_catalog.pg_current_xact_id()::pg_catalog.text AS xid,pg_catalog.current_setting('session_replication_role') AS mode`)).rows[0]!;
    if (facts.mode !== "origin" || facts.cluster !== fresh.observation.cluster || facts.database !== fresh.observation.database
      || facts.login !== fresh.observation.login || facts.login !== installation.migrationLogin) fail("invalid_input");
    const manifest = expectedManifest(installation);
    const expectedLedger = [manifest.baseline, ...manifest.forward];
    if (expectedLedger.length !== 91 || packet.compatible.catalogueId !== manifest.objectInventorySha256
      || fresh.compatible.catalogueId !== manifest.objectInventorySha256) fail("schema_conflict");
    const ledger = await client.query<{ catalog_path: string; sha256: string; position: number }>(
      "SELECT catalog_path,sha256,position FROM public.platform_schema_migrations ORDER BY position");
    if (JSON.stringify(ledger.rows) !== JSON.stringify(expectedLedger.map((unit, position) => ({ catalog_path: unit.file, sha256: unit.sha256, position })))) fail("schema_conflict");
    const inventory = await qualifiedPostgresCatalogPayload(client, installation, migrationLock);
    if (digest(inventory) !== manifest.objectInventorySha256) fail("schema_conflict");
    const ledgerBefore = (await client.query<{ value: string }>("SELECT pg_catalog.to_jsonb(m)::pg_catalog.text AS value FROM public.platform_schema_migrations m ORDER BY position")).rows;
    const keyIdentity = await client.query("SELECT tableoid::pg_catalog.text,ctid::pg_catalog.text,xmin::pg_catalog.text FROM acquisition_private.installation_key");
    // Lock the whole public/app census, including excluded tables. Unknown data
    // cannot appear during import, and no observer sees intermediate rows.
    const relations = (await client.query<{ schema: string; table: string }>(`SELECT n.nspname AS schema,c.relname AS table
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE pg_catalog.left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
      AND c.relkind IN ('r','p') ORDER BY n.nspname,c.relname`)).rows;
    for (const relation of relations) await client.query(`LOCK TABLE ${quoted(relation.schema)}.${quoted(relation.table)} IN SHARE ROW EXCLUSIVE MODE`);
    for (const table of connectedNativeStoreTables) {
      const actual = (await client.query<{ name: string; type: string }>(`SELECT a.attname AS name,
        pg_catalog.format_type(a.atttypid,a.atttypmod) AS type FROM pg_catalog.pg_attribute a
        WHERE a.attrelid=$1::pg_catalog.regclass AND a.attnum>0 AND NOT a.attisdropped
        AND a.attgenerated='' AND a.attidentity='' ORDER BY a.attnum`, [`public.${table}`])).rows;
      if (JSON.stringify(actual) !== JSON.stringify(source.get(table)!.columns.map(({ name, type }) => ({ name, type })))) fail("schema_conflict", table);
    }
    await assertInsertTriggers(client);
    await assertOutsideEmpty(client, relations);
    if (await equalCensus(client, source)) {
      await client.query("COMMIT");
      result = { captureSha256: packet.sha256, replayed: true, neutralizedHistoricalHoldNotifications: 0 };
    } else {
      // This is an equality check against actual pristine installation data, not
      // caller fresh=true. The host's real creation/qualification remains required.
      for (const table of connectedNativeStoreTables) {
        if (!settings.includes(table as SettingsTable) && baseline.get(table)!.rows.length) fail("target_conflict", table);
      }
      if (!await equalCensus(client, baseline)) fail("target_conflict");
      const control = await client.query("SELECT mode FROM public.subscription_delivery_alignment_control WHERE singleton=true");
      if (control.rows.length !== 1 || control.rows[0].mode !== "off") fail("target_conflict", "subscription_delivery_alignment_control");
      for (const table of settings) if (table !== "subscription_delivery_alignment_control") {
        await restoreSettings(client, baseline.get(table)!, source.get(table)!);
      }
      let neutralized = 0;
      for (const table of order) {
        const rows = source.get(table)!;
        const b = packet.compatible.tables.find(value => value.table === table);
        if (b && !["clients", "subscription_cycles", "commerce_orders", "commerce_order_items"].includes(table)) {
          const { sha256: _old, ...payload } = { ...packet.compatible, tables: [{ ...b, rows: parentOrder(table, b.rows) }] };
          const bounded: CompatiblePostgresPacket = { ...payload, sha256: digest(JSON.stringify(payload)) };
          await restoreCompatiblePostgresRows({ catalogueId: manifest.objectInventorySha256, packet: bounded,
            target: { withTransaction: work => work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) }) } });
        } else for (const row of parentOrder(table, rows.rows)) {
          if (table === "clients") await client.query(`SELECT public.client_import_retained_row(p.id,p.created_at,p.updated_at,p.email,
            p.first_name,p.last_name,p.phone,p.country,p.lifecycle_stage,p.acquisition_source,p.external_ref,p.metadata,p.principal_id)
            FROM pg_catalog.jsonb_populate_record(NULL::public.clients,$1::jsonb) p`, [row]);
          else if (table === "subscription_cycles") await client.query(`SELECT public.subscription_cycle_import_retained_row(p.id,p.subscription_id,
            p.scheduled_at,p.status,p.created_at,p.updated_at,p.renewal_operation_id,p.renewal_operation_fingerprint)
            FROM pg_catalog.jsonb_populate_record(NULL::public.subscription_cycles,$1::jsonb) p`, [row]);
          else await insert(client, rows, row);
        }
        if (table === "commerce_order_holds") neutralized = await neutralizeHistoricalHoldNotifications(client, source, facts.xid);
      }
      // No alignment case or source policy is activated while shipment/hold INSERT
      // triggers replay. Preserve the captured policy only after all retained data.
      await restoreSettings(client, baseline.get("subscription_delivery_alignment_control")!, source.get("subscription_delivery_alignment_control")!);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await assertOutsideEmpty(client, relations);
      if (!await equalCensus(client, source)) fail("target_conflict");
      if (await qualifiedPostgresCatalogPayload(client, installation, migrationLock) !== inventory) fail("schema_conflict");
      if (JSON.stringify((await client.query<{ value: string }>("SELECT pg_catalog.to_jsonb(m)::pg_catalog.text AS value FROM public.platform_schema_migrations m ORDER BY position")).rows) !== JSON.stringify(ledgerBefore)) fail("schema_conflict");
      if (JSON.stringify((await client.query("SELECT tableoid::pg_catalog.text,ctid::pg_catalog.text,xmin::pg_catalog.text FROM acquisition_private.installation_key")).rows) !== JSON.stringify(keyIdentity.rows)) fail("target_conflict", "acquisition_private.installation_key");
      if ((await client.query("SELECT pg_catalog.pg_current_xact_id()::pg_catalog.text AS xid")).rows[0].xid !== facts.xid) fail("invalid_input");
      await client.query("COMMIT");
      result = { captureSha256: packet.sha256, replayed: false, neutralizedHistoricalHoldNotifications: neutralized };
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof PostgresTransferError) throw error;
    if (typeof (error as { code?: unknown })?.code === "string" && /^23/.test((error as { code: string }).code)) fail("target_conflict");
    throw new PostgresTransferError("database_unavailable");
  } finally {
    try {
      if (locked && (await client.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1,0)) AS unlocked", [migrationLock])).rows[0]?.unlocked !== true) {
        unlockFailed = true;
      }
    } catch { unlockFailed = true; }
    finally { client.release(unlockFailed); }
  }
  if (unlockFailed || !result) throw new PostgresTransferError("database_unavailable");
  return result;
}

function copyCapture(input: ConnectedNativeStoreCapture): ConnectedNativeStoreCapture {
  try {
    const copy = JSON.parse(JSON.stringify(input)) as ConnectedNativeStoreCapture;
    const { sha256, ...body } = copy;
    if (copy.format !== "openlup.native-retained-store.v1" || digest(JSON.stringify(body)) !== sha256) fail("invalid_input");
    const all = tables(copy);
    if (all.size !== connectedNativeStoreTables.length || connectedNativeStoreTables.some(table => !all.has(table))) fail("invalid_input");
    let count = 0, bytes = 0;
    for (const table of all.values()) {
      for (const column of table.columns) quoted(column.name);
      if (!table.columns.length || new Set(table.columns.map(column => column.name)).size !== table.columns.length) fail("invalid_input");
      for (const row of table.rows) {
        const value = JSON.parse(row) as Record<string, unknown>;
        if (!value || Array.isArray(value) || Object.keys(value).sort().join("\0") !== table.columns.map(column => column.name).sort().join("\0")) fail("invalid_input");
        count++; bytes += Buffer.byteLength(row);
      }
    }
    if (count > 10000 || bytes > 64 * 1024 * 1024) fail("limit_exceeded");
    return copy;
  } catch (error) { if (error instanceof PostgresTransferError) throw error; fail("invalid_input"); }
}

function tables(packet: ConnectedNativeStoreCapture): Map<TableName, Rows> {
  const all: Rows[] = [...packet.compatible.tables, ...packet.owned];
  if (new Set(all.map(table => table.table)).size !== all.length) fail("invalid_input");
  return new Map<TableName, Rows>(all.map(table => [table.table, table]));
}
function expectedManifest(installation: QualifiedPostgresInstallation) {
  const root = process.cwd(), raw = readPlatformMigrationManifest(root), catalog = readPlatformMigrations(root);
  if (!raw || catalog.errors.length || evaluatePlatformMigrationManifest({ manifest: raw, migrations: catalog.migrations }).length) fail("schema_conflict");
  return selectPlatformMigrationManifest(raw as PlatformMigrationManifest, "qualified-v2", {
    migrationIsBootstrap: installation.migrationLogin === installation.bootstrapLogin, hasRestore: installation.restoreLogin !== undefined,
  });
}
async function equalCensus(client: PoolClient, expected: Map<TableName, Rows>): Promise<boolean> {
  for (const [table, data] of expected) {
    const actual = (await client.query<{ value: string }>(`SELECT pg_catalog.to_jsonb(t)::pg_catalog.text AS value FROM public.${quoted(table)} t`)).rows.map(row => row.value).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...data.rows].sort())) return false;
  }
  return true;
}
async function assertOutsideEmpty(client: PoolClient, relations: readonly { schema: string; table: string }[]): Promise<void> {
  for (const relation of relations) {
    if (relation.schema === "public" && (connectedNativeStoreTables.includes(relation.table as TableName) || relation.table === "platform_schema_migrations")) continue;
    if (relation.schema === "acquisition_private" && relation.table === "installation_key") continue;
    if ((await client.query(`SELECT 1 FROM ${quoted(relation.schema)}.${quoted(relation.table)} LIMIT 1`)).rows.length) fail("unsupported_table", `${relation.schema}.${relation.table}`);
  }
}
async function insert(client: PoolClient, table: Rows, row: string): Promise<void> {
  const name = `public.${quoted(table.table)}`, columns = table.columns.map(column => quoted(column.name)).join(",");
  await client.query(`INSERT INTO ${name} (${columns}) SELECT ${columns} FROM pg_catalog.jsonb_populate_record(NULL::${name},$1::jsonb) ON CONFLICT DO NOTHING`, [row]);
  if ((await client.query(`SELECT 1 FROM ${name} t WHERE pg_catalog.to_jsonb(t)=$1::jsonb`, [row])).rows.length !== 1) fail("target_conflict", table.table);
}
async function restoreSettings(client: PoolClient, baseline: Rows, source: Rows): Promise<void> {
  // Exactly seven read-approved factory tables. Each deletion matches one whole
  // verified pristine row, never arbitrary existing data or an inferred diff.
  if (!settings.includes(source.table as SettingsTable) || source.table !== baseline.table) fail("invalid_input");
  for (const row of baseline.rows) {
    if ((await client.query(`DELETE FROM public.${quoted(source.table)} t WHERE pg_catalog.to_jsonb(t)=$1::jsonb RETURNING 1`, [row])).rows.length !== 1) fail("target_conflict", source.table);
  }
  for (const row of source.rows) await insert(client, source, row);
}
function parentOrder(table: TableName, rows: readonly string[]): string[] {
  if (table !== "fulfillment_shipments" && table !== "invoicing_duties") return [...rows];
  const field = table === "fulfillment_shipments" ? "replaces_shipment_id" : "parent_duty_id";
  const pending = new Map<string, { row: string; parent: string | null }>();
  for (const row of rows) {
    // Inspect IDs only. The original PostgreSQL row text remains unchanged.
    const value = JSON.parse(row) as Record<string, unknown>;
    if (typeof value.id !== "string" || value[field] !== null && typeof value[field] !== "string" || pending.has(value.id)) fail("target_conflict", table);
    pending.set(value.id, { row, parent: value[field] as string | null });
  }
  const ordered: string[] = [], done = new Set<string>();
  for (const id of pending.keys()) {
    const chain: string[] = [], visiting = new Set<string>();
    let next: string | null = id;
    while (next !== null && !done.has(next)) {
      if (visiting.has(next) || !pending.has(next)) fail("target_conflict", table);
      visiting.add(next); chain.push(next); next = pending.get(next)!.parent;
    }
    for (const current of chain.reverse()) { ordered.push(pending.get(current)!.row); done.add(current); }
  }
  return ordered;
}
async function assertInsertTriggers(client: PoolClient): Promise<void> {
  const allowed: Readonly<Record<string, readonly string[]>> = {
    clients: ["customer_subject_capture_lifecycle_trigger"], subscription_cycles: ["trg_subscription_delivery_alignment_guard_cycle_insert"],
    commerce_orders: ["trg_commerce_orders_line_sum"], commerce_order_items: ["trg_commerce_order_items_line_sum"],
    commerce_order_holds: ["trg_fulfillment_emit_shipment_exception", "trg_subscription_delivery_alignment_exception_case"],
    fulfillment_shipments: ["trg_subscription_delivery_alignment_on_delivery"],
  };
  const actual = (await client.query<{ table: string; name: string }>(`SELECT c.relname AS table,t.tgname AS name FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal AND (t.tgtype & 4)<>0 AND t.tgenabled IN ('O','A')`)).rows;
  for (const trigger of actual) if (connectedNativeStoreTables.includes(trigger.table as TableName) && !allowed[trigger.table]?.includes(trigger.name)) fail("insert_trigger_requires_owner", trigger.table);
  // Full definitions/functions/roles are independently pinned by the existing
  // qualified inventory. A known name alone never attests harmless behavior.
}
async function neutralizeHistoricalHoldNotifications(client: PoolClient, source: Map<TableName, Rows>, xid: string): Promise<number> {
  const keys = new Set(source.get("outbox_events")!.rows.map(row => {
    const value = JSON.parse(row) as Record<string, unknown>; return JSON.stringify([value.event_type, value.idempotency_key]);
  }));
  let removed = 0;
  for (const hold of source.get("commerce_order_holds")!.rows) {
    const id = String((JSON.parse(hold) as Record<string, unknown>).id);
    if (keys.has(JSON.stringify(["commerce.shipment.exception", `shipment_exception:${id}`]))) continue;
    const observed = (await client.query<{ id: string; value: string; matches: boolean }>(`SELECT o.id::pg_catalog.text AS id,
      pg_catalog.to_jsonb(o)::pg_catalog.text AS value,
      p.reason='fulfillment_exception' AND p.created_by IS NULL AND p.status='active'
      AND o.aggregate_type='commerce_order' AND o.aggregate_id=p.order_id
      AND o.payload=pg_catalog.jsonb_build_object('orderUuid',p.order_id,'holdUuid',p.id,'occurredAt',p.created_at)
      AND o.metadata=pg_catalog.jsonb_build_object('source','fulfillment_emit_shipment_exception_notification')
      AND o.status='pending' AND o.attempts=0 AND o.processed_at IS NULL AND o.error IS NULL
      AND o.created_at=pg_catalog.transaction_timestamp() AND o.available_at=pg_catalog.transaction_timestamp()
      AND o.xmin::pg_catalog.text=pg_catalog.mod($2::pg_catalog.numeric,4294967296)::pg_catalog.int8::pg_catalog.text AS matches
      FROM public.outbox_events o,pg_catalog.jsonb_populate_record(NULL::public.commerce_order_holds,$1::jsonb) p
      WHERE o.event_type='commerce.shipment.exception' AND o.idempotency_key='shipment_exception:'||p.id::pg_catalog.text`, [hold, xid])).rows;
    if (!observed.length) continue;
    if (observed.length !== 1 || observed[0]!.matches !== true) fail("target_conflict", "outbox_events");
    const event = observed[0]!;
    const deleted = await client.query(`DELETE FROM public.outbox_events o WHERE o.id=$1::uuid
      AND o.event_type='commerce.shipment.exception' AND o.idempotency_key=$2
      AND pg_catalog.to_jsonb(o)=$3::jsonb
      AND o.xmin::pg_catalog.text=pg_catalog.mod($4::pg_catalog.numeric,4294967296)::pg_catalog.int8::pg_catalog.text RETURNING o.id`,
    [event.id, `shipment_exception:${id}`, event.value, xid]);
    if (deleted.rows.length !== 1) fail("target_conflict", "outbox_events");
    removed++;
  }
  return removed;
}
function quoted(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) fail("invalid_input");
  return `"${value}"`;
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function fail(code: "invalid_input" | "schema_conflict" | "target_conflict" | "unsupported_table" | "limit_exceeded" | "insert_trigger_requires_owner", table?: string): never {
  throw new PostgresTransferError(code, table);
}
