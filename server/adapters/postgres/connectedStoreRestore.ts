import { nativeCatalogPublication } from "@openlup/platform/catalog";
import type { Pool, PoolClient } from "pg";
import {
  PostgresTransferError, restoreCompatiblePostgresRows,
  type CompatiblePostgresPacket,
} from "@openlup/platform/portability";
import { evaluatePlatformMigrationManifest, readPlatformMigrationManifest, readPlatformMigrations, selectPlatformMigrationManifest, type PlatformMigrationManifest } from "../../../scripts/platform-migration-manifest.js";
import { qualifiedAdminPostgresCatalogPayload, qualifiedPostgresCatalogPayload,
  assertQualifiedAdminPostgresSelection, type QualifiedAdminPostgresInstallation, type QualifiedPostgresInstallation } from "./qualifiedInstall.js";
import { assertConnectedCatalogPublications, connectedNativeStoreTables,
  connectedStoreClusterIdentitySql, connectedStoreRowSource, readPrivacyDeclarationCensus,
  requiredPrivacyDeclarationTable, type ConnectedNativeStoreCapture } from "./connectedStoreCapture.js";
import {
  connectedStoreAllowedInsertTriggers,
  connectedStoreOutsideProfileRelations,
  connectedStoreRestoreOrder,
  connectedStoreSettingsTables,
} from "./connectedStoreDomains/index.js";
import { paymentsDomain } from "./connectedStoreDomains/payments.js";
import { renewalUpgradeCohort, tablesForRenewalUpgradeCohort } from "./connectedStoreDomains/subscriptions.js";
import {
  captureTables as tables,
  copyCapture,
  digest,
  listUserRelations,
  quoteRestoreIdentifier as quoted,
  refuseSourceSchema,
  type ConnectedStoreSourceShape as SourceShape,
  type ConnectedStoreTableName as TableName,
  type ConnectedStoreTableRows as Rows,
} from "./connectedTransferPacket.js";

export {
  mapManagedIdentityForConnectedRestore,
  type ManagedIdentityMappingResult,
  type ManagedIdentityMappingSource,
} from "./connectedManagedIdentity.js";

const { catalogPublicationAdmissionRefusal, decodePublicationPacket, requireDecodedPublication } = nativeCatalogPublication;

const migrationLock = "openlup:public-platform-migrations:v1";
const paymentTables = ["commerce_settlement_intents", ...Object.values(paymentsDomain.restore).flat()] as const;
const paymentQualificationRelation = "public.payment_capture_time_test_qualification";

export function connectedStoreSourceShape(
  _profile: "bootstrap" | "separate" | QualifiedAdminPostgresInstallation["roleMode"],
  catalogueId: string | undefined, currentCatalogueId: string,
): SourceShape {
  return catalogueId === currentCatalogueId ? "current" : "unsupported";
}

const settings = connectedStoreSettingsTables satisfies readonly TableName[];
type SettingsTable = typeof settings[number];

// Explicit owner order, not schema discovery or a general FK/translation engine.
const order = connectedStoreRestoreOrder satisfies readonly TableName[];

/**
 * One finite native-profile owner transaction. The host must actually own a
 * newly installed target, its pristine capture and exclusion of every target
 * writer/dispatcher. A supplied capture binds expected data; it does not certify
 * that host prerequisite. No user route, role grant or target activation exists.
 * Source and target must use the same current qualified inventory.
 */
export async function restoreConnectedNativeStore(input: {
  owner: Pool;
  installation: QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation;
  packet: ConnectedNativeStoreCapture;
  freshTarget: ConnectedNativeStoreCapture;
}): Promise<{ captureSha256: string; replayed: boolean; neutralizedHistoricalHoldNotifications: number }> {
  const installation = structuredClone(input.installation);
  if (installation?.generation !== "qualified-admin"
    && (installation?.generation !== "qualified-v2" || !installation.restoreLogin)) fail("invalid_input");
  if (installation.generation === "qualified-admin") assertQualifiedAdminPostgresSelection(installation);
  const profile = installation.generation === "qualified-admin" ? installation.roleMode
    : installation.migrationLogin === installation.bootstrapLogin ? "bootstrap" : "separate";
  const manifest = expectedManifest(installation);
  const cohortInstalled = manifest.forward.some(unit => renewalUpgradeCohort.forward.test(unit.file));
  const profileTables = tablesForRenewalUpgradeCohort(connectedNativeStoreTables, cohortInstalled);
  const shape = connectedStoreSourceShape(profile, input.packet?.compatible?.catalogueId, manifest.objectInventorySha256);
  const packet = copyCapture(input.packet, shape, profileTables);
  const fresh = copyCapture(input.freshTarget, "current", profileTables);
  if (packet.observation.cluster === fresh.observation.cluster
    && packet.observation.database === fresh.observation.database) fail("invalid_input");
  const source = tables(packet), baseline = tables(fresh);
  for (const capture of [source, baseline]) {
    for (const table of ["commerce_orders", "outbox_events"] as const) {
      const stamped = capture.get(table)!.rows.some(row => {
        const { metadata } = JSON.parse(row) as { metadata?: { boundary?: unknown } | null };
        return metadata !== null && typeof metadata === "object"
          && (Object.hasOwn(metadata, "catalogAdmissionOwnerOrigin")
            || (table === "outbox_events" && metadata.boundary === "catalog_admission_write_governed_draft"));
      });
      if (stamped) throw Object.assign(new PostgresTransferError("unsupported_table", table), {
        remedy: "This version cannot restore stamped governed drafts. Keep the capture for a version that supports their restore.",
      });
    }
  }
  try {
    requireDecodedPublication(decodePublicationPacket({
      publications: source.get("catalog_publications")!.rows, skuRevisions: source.get("catalog_sku_revisions")!.rows,
    }));
  } catch (error) {
    const refusal = catalogPublicationAdmissionRefusal(error);
    if (!refusal) throw error;
    throw Object.assign(new PostgresTransferError("target_conflict"), { cause: refusal });
  }
  const client = await input.owner.connect().catch(() => { throw new PostgresTransferError("database_unavailable"); });
  let locked = false, unlockFailed = false;
  let result: { captureSha256: string; replayed: boolean; neutralizedHistoricalHoldNotifications: number } | undefined;
  try {
    await client.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1,0))", [migrationLock]);
    locked = true;
    await client.query("BEGIN");
    await client.query("SET LOCAL TimeZone = 'UTC'");
    const facts = (await client.query<{ cluster: string; database: string; login: string; xid: string; mode: string }>(`SELECT
      ${connectedStoreClusterIdentitySql} AS cluster,
      pg_catalog.current_database() AS database,session_user::pg_catalog.text AS login,
      pg_catalog.pg_current_xact_id()::pg_catalog.text AS xid,pg_catalog.current_setting('session_replication_role') AS mode`)).rows[0]!;
    if (facts.mode !== "origin" || facts.cluster !== fresh.observation.cluster || facts.database !== fresh.observation.database
      || facts.login !== fresh.observation.login || facts.login !== installation.migrationLogin) fail("invalid_input");
    const expectedLedger = [manifest.baseline, ...manifest.forward];
    if (fresh.compatible.catalogueId !== manifest.objectInventorySha256) fail("schema_conflict");
    const ledger = await client.query<{ catalog_path: string; sha256: string; position: number }>(
      "SELECT catalog_path,sha256,position FROM public.platform_schema_migrations ORDER BY position");
    if (ledger.rows.length !== expectedLedger.length
      || JSON.stringify(ledger.rows) !== JSON.stringify(expectedLedger.map((unit, position) => ({ catalog_path: unit.file, sha256: unit.sha256, position })))) fail("schema_conflict");
    const ledgerBefore = (await client.query<{ value: string }>("SELECT pg_catalog.to_jsonb(m)::pg_catalog.text AS value FROM public.platform_schema_migrations m ORDER BY position")).rows;
    // The restricted migrator has ADMIN but no inherited owner access at rest.
    // Observe its sealed graph first, then open only the already-admitted
    // acquisition owner privilege inside this transaction for census/locks.
    const inventory = installation.generation === "qualified-admin" ? await catalogPayload(client, installation) : undefined;
    if (inventory !== undefined && digest(inventory) !== manifest.objectInventorySha256) fail("schema_conflict");
    if (installation.generation === "qualified-admin") await openRestrictedOwnerWindow(client, installation);
    const keyIdentity = await client.query("SELECT tableoid::pg_catalog.text,ctid::pg_catalog.text,xmin::pg_catalog.text FROM acquisition_private.installation_key");
    // Lock the whole public/app census, including excluded tables. Unknown data
    // cannot appear during import, and no observer sees intermediate rows.
    const relations = await listUserRelations(client);
    if (relations.length > 0) {
      const lockedRelations = relations.map(relation => `${quoted(relation.schema)}.${quoted(relation.table)}`).join(",");
      await client.query(`LOCK TABLE ${lockedRelations} IN SHARE ROW EXCLUSIVE MODE`);
    }
    // Inspect definitions after table locks, before any retained-data mutation.
    const lockedInventory = inventory ?? await catalogPayload(client, installation);
    if (digest(lockedInventory) !== manifest.objectInventorySha256) fail("schema_conflict");
    const declared = JSON.stringify(packet.requiredPrivacyContributorIds);
    const assertPrivacyDeclaration = async () => {
      const live = await readPrivacyDeclarationCensus({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
      if (declared !== JSON.stringify(live)) fail("target_conflict", requiredPrivacyDeclarationTable);
    };
    if (declared !== JSON.stringify(fresh.requiredPrivacyContributorIds)) fail("target_conflict", requiredPrivacyDeclarationTable);
    await assertPrivacyDeclaration();
    const actualColumnsByTable = new Map<string, { name: string; type: string }[]>();
    const { rows: attributeRows } = await client.query<{ table: string; name: string; type: string }>(`SELECT c.relname AS table,
      a.attname AS name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::pg_catalog.text[]) AND c.relkind='r'
      AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='' AND a.attidentity=''
      ORDER BY c.relname,a.attnum`, [[...profileTables]]);
    for (const row of attributeRows) {
      const list = actualColumnsByTable.get(row.table);
      if (list) list.push({ name: row.name, type: row.type });
      else actualColumnsByTable.set(row.table, [{ name: row.name, type: row.type }]);
    }
    for (const table of profileTables) {
      const actual = actualColumnsByTable.get(table) ?? [];
      const columns = source.get(table)!.columns.map(({ name, type }) => ({ name, type }));
      if (JSON.stringify(actual) !== JSON.stringify(columns)) refuseSourceSchema(table);
    }
    await assertInsertTriggers(client);
    const replayed = await equalCensus(client, source);
    if (!replayed && paymentTables.some(table => source.get(table)!.rows.length > 0)) {
      await client.query(`DELETE FROM ${paymentQualificationRelation}`);
    }
    await assertOutsideEmpty(client, relations, profileTables, replayed);
    // Sized bindings cannot be replayed as final rows through the insert guard.
    // Refuse before restoring settings or inserting any retained source data.
    if (source.get("subscriptions")!.rows.some(row =>
      (JSON.parse(row) as Record<string, unknown>).configured_offer_version !== "classic")) fail("unsupported_table", "subscriptions");
    if (replayed) {
      await assertConnectedCatalogPublications(client);
      if (JSON.stringify((await client.query("SELECT tableoid::pg_catalog.text,ctid::pg_catalog.text,xmin::pg_catalog.text FROM acquisition_private.installation_key")).rows) !== JSON.stringify(keyIdentity.rows)) fail("target_conflict", "acquisition_private.installation_key");
      if (installation.generation === "qualified-admin") await closeRestrictedOwnerWindow(client, installation);
      if (await catalogPayload(client, installation) !== lockedInventory) fail("schema_conflict");
      if (JSON.stringify((await client.query<{ value: string }>("SELECT pg_catalog.to_jsonb(m)::pg_catalog.text AS value FROM public.platform_schema_migrations m ORDER BY position")).rows) !== JSON.stringify(ledgerBefore)) fail("schema_conflict");
      await client.query("COMMIT");
      result = { captureSha256: packet.sha256, replayed: true, neutralizedHistoricalHoldNotifications: 0 };
    } else {
      // This is an equality check against actual pristine installation data, not
      // caller fresh=true. The host's real creation/qualification remains required.
      for (const table of profileTables) {
        if (!settings.includes(table as SettingsTable) && baseline.get(table)!.rows.length) fail("target_conflict", table);
      }
      if (!await equalCensus(client, baseline)) fail("target_conflict");
      const control = await client.query("SELECT mode FROM public.subscription_delivery_alignment_control WHERE singleton=true");
      if (control.rows.length !== 1 || control.rows[0].mode !== "off") fail("target_conflict", "subscription_delivery_alignment_control");
      for (const table of settings) if (table !== "subscription_delivery_alignment_control") {
        await restoreSettings(client, baseline.get(table)!, source.get(table)!);
      }
      const governedProducts = new Set(source.get("catalog_publications")!.rows.map(row => (JSON.parse(row) as { product_id: string }).product_id));
      const erasedOrders = source.get("commerce_order_tax_snapshots")!.rows
        .map(row => JSON.parse(row) as { order_id: string; destination_erased: boolean })
        .filter(row => row.destination_erased).map(row => row.order_id);
      let neutralized = 0;
      for (const table of tablesForRenewalUpgradeCohort(order, cohortInstalled)) {
        const rows = source.get(table)!;
        if (table === "commerce_orders" && erasedOrders.length > 0) {
          await client.query("SELECT public.commerce_order_money_v2_mark_restore_orders($1::uuid[])", [erasedOrders]);
        }
        const copyingPrivacyReceipts = table === "identity_privacy_erasures" && rows.rows.length > 0;
        if (copyingPrivacyReceipts) await client.query("SELECT pg_catalog.set_config('app.tax_historical_receipt_restore',$1,true)", [facts.xid]);
        if (table === "subscription_price_policy_revisions") {
          // Only the policy copy may retain the provenance of a guarded close.
          await client.query("INSERT INTO public.subscription_price_policy_restore_capabilities VALUES (pg_catalog.pg_current_xact_id())");
        }
        const b = packet.compatible.tables.find(value => value.table === table);
        // Keep guarded rows on the locked owner path, including both renewal
        // acceptance triggers admitted by the qualified inventory below.
        if (b && !["clients", "subscriptions", "subscription_events", "subscription_cycles", "subscription_renewal_terms",
          "subscription_renewal_operations", "commerce_orders", "commerce_order_items", "outbox_events"].includes(table)) {
          const { sha256: _old, ...payload } = { ...packet.compatible, catalogueId: manifest.objectInventorySha256,
            tables: [{ ...b, rows: parentOrder(table, b.rows) }] };
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
          else if (table === "payment_provider_states") {
            const staged = (await client.query<{ value: string }>(`SELECT pg_catalog.jsonb_set(
              $1::jsonb,'{active_attempt_id}','null'::jsonb)::pg_catalog.text AS value`, [row])).rows[0]!.value;
            await insert(client, rows, staged);
          }
          else if (table === "payment_simulator_attempts") {
            // Immediate cyclic FKs and the state/pointer CHECK require staging
            // both fields together. No writer can observe this locked transaction.
            const staged = (await client.query<{ value: string }>(`SELECT pg_catalog.jsonb_set(
              pg_catalog.jsonb_set($1::jsonb,'{last_observation_id}','null'::jsonb),
              '{state}','"dispatched"'::jsonb)::pg_catalog.text AS value`, [row])).rows[0]!.value;
            await insert(client, rows, staged);
          }
          else if (table === "catalog_products") {
            // Products reference their SKUs and document revisions, which in
            // turn reference the product. Stage both nullable pointers, then
            // install each captured value after its parents exist.
            const staged = (await client.query<{ value: string }>(`SELECT pg_catalog.jsonb_set(
              pg_catalog.jsonb_set($1::jsonb,'{primary_sku_id}','null'::jsonb),
              '{current_document_revision_id}','null'::jsonb)::pg_catalog.text AS value`, [row])).rows[0]!.value;
            await insert(client, rows, staged);
          }
          else {
            // This owner path must not depend on a trigger's actor exception.
            // Channel evidence has no retained transfer mapping in this profile.
            if (table === "outbox_events" && ["channel.pull-page.v1", "channel.purchase-line.v1", "channel.purchase-source.v1"]
              .includes(String((JSON.parse(row) as Record<string, unknown>).event_type))) fail("unsupported_table", table);
            await insert(client, rows, row);
          }
        }
        if (copyingPrivacyReceipts) await client.query("SELECT pg_catalog.set_config('app.tax_historical_receipt_restore','',true)");
        if (table === "subscription_price_policy_revisions") {
          await client.query("DELETE FROM public.subscription_price_policy_restore_capabilities WHERE transaction_id=pg_catalog.pg_current_xact_id()");
        }
        if (table === "payment_provider_attempts") for (const state of source.get("payment_provider_states")!.rows) {
          const updated = await client.query(`UPDATE public.payment_provider_states s
            SET active_attempt_id=x.active_attempt_id
            FROM pg_catalog.jsonb_populate_record(NULL::public.payment_provider_states,$1::jsonb) x
            WHERE s.id=x.id AND s.active_attempt_id IS NULL
              AND (pg_catalog.to_jsonb(s)-'active_attempt_id')=(pg_catalog.to_jsonb(x)-'active_attempt_id')
            RETURNING s.id`, [state]);
          if (updated.rows.length !== 1) fail("target_conflict", "payment_provider_states");
        }
        if (table === "payment_simulator_observations") for (const attempt of source.get("payment_simulator_attempts")!.rows) {
          const updated = await client.query(`UPDATE public.payment_simulator_attempts a
            SET state=x.state,last_observation_id=x.last_observation_id
            FROM pg_catalog.jsonb_populate_record(NULL::public.payment_simulator_attempts,$1::jsonb) x
            WHERE a.id=x.id AND a.state='dispatched' AND a.last_observation_id IS NULL
              AND (pg_catalog.to_jsonb(a)-'state'-'last_observation_id')=(pg_catalog.to_jsonb(x)-'state'-'last_observation_id')
            RETURNING a.id`, [attempt]);
          if (updated.rows.length !== 1) fail("target_conflict", "payment_simulator_attempts");
        }
        if (table === "catalog_product_document_revisions") for (const product of source.get("catalog_products")!.rows) {
          const value = JSON.parse(product) as { id: string; current_document_revision_id: string | null; publication_facts: unknown };
          if (value.current_document_revision_id === null) continue;
          if (governedProducts.has(value.id) || value.publication_facts !== null) await client.query(`INSERT INTO public.catalog_publication_pointer_capabilities(transaction_id,product_id,revision_id,command_fingerprint)
            SELECT pg_current_xact_id(),x.id,x.current_document_revision_id,$2
            FROM pg_catalog.jsonb_populate_record(NULL::public.catalog_products,$1::jsonb) x`, [product, packet.sha256]);
          const updated = await client.query(`UPDATE public.catalog_products p SET current_document_revision_id=x.current_document_revision_id
            FROM pg_catalog.jsonb_populate_record(NULL::public.catalog_products,
              pg_catalog.jsonb_set($1::jsonb,'{primary_sku_id}','null'::jsonb)) x
            WHERE p.id=x.id AND p.current_document_revision_id IS NULL AND x.current_document_revision_id IS NOT NULL
              AND (pg_catalog.to_jsonb(p)-'current_document_revision_id')=(pg_catalog.to_jsonb(x)-'current_document_revision_id')
            RETURNING p.id`, [product]);
          if (updated.rows.length !== 1) fail("target_conflict", "catalog_products");
        }
        if (table === "catalog_skus") for (const product of source.get("catalog_products")!.rows) {
          const value = JSON.parse(product) as { id: string; primary_sku_id: string | null };
          if (value.primary_sku_id === null) continue;
          const updated = await client.query(`UPDATE public.catalog_products p SET primary_sku_id=x.primary_sku_id
            FROM pg_catalog.jsonb_populate_record(NULL::public.catalog_products,$1::jsonb) x
            WHERE p.id=x.id AND p.primary_sku_id IS NULL AND x.primary_sku_id IS NOT NULL
              AND (pg_catalog.to_jsonb(p)-'primary_sku_id')=(pg_catalog.to_jsonb(x)-'primary_sku_id')
            RETURNING p.id`, [product]);
          if (updated.rows.length !== 1) fail("target_conflict", "catalog_products");
        }
        if (table === "shipment_external_refs") await neutralizeHistoricalNotifications(client, source, facts.xid, table);
        if (table === "commerce_order_holds") neutralized = await neutralizeHistoricalNotifications(client, source, facts.xid, table);
      }
      // No alignment case or source policy is activated while shipment/hold INSERT
      // triggers replay. Preserve the captured policy only after all retained data.
      await restoreSettings(client, baseline.get("subscription_delivery_alignment_control")!, source.get("subscription_delivery_alignment_control")!);
      await nativeCatalogPublication.assertPublishedSkuIdentity(client);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      if (erasedOrders.length > 0) {
        await client.query("DELETE FROM public.commerce_order_money_v2_restore_marks WHERE transaction_id=pg_catalog.pg_current_xact_id()");
      }
      await assertOutsideEmpty(client, relations, profileTables);
      if (!await equalCensus(client, source)) fail("target_conflict");
      if (JSON.stringify((await client.query("SELECT tableoid::pg_catalog.text,ctid::pg_catalog.text,xmin::pg_catalog.text FROM acquisition_private.installation_key")).rows) !== JSON.stringify(keyIdentity.rows)) fail("target_conflict", "acquisition_private.installation_key");
      if (installation.generation === "qualified-admin") await closeRestrictedOwnerWindow(client, installation);
      if (await catalogPayload(client, installation) !== lockedInventory) fail("schema_conflict");
      if (JSON.stringify((await client.query<{ value: string }>("SELECT pg_catalog.to_jsonb(m)::pg_catalog.text AS value FROM public.platform_schema_migrations m ORDER BY position")).rows) !== JSON.stringify(ledgerBefore)) fail("schema_conflict");
      if ((await client.query("SELECT pg_catalog.pg_current_xact_id()::pg_catalog.text AS xid")).rows[0].xid !== facts.xid) fail("invalid_input");
      await assertPrivacyDeclaration();
      await client.query("COMMIT");
      result = { captureSha256: packet.sha256, replayed: false, neutralizedHistoricalHoldNotifications: neutralized };
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof PostgresTransferError) throw error;
    const refusal = catalogPublicationAdmissionRefusal(error);
    if (refusal) throw Object.assign(new PostgresTransferError("target_conflict"), { cause: refusal });
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

function expectedManifest(installation: QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation) {
  const root = process.cwd(), raw = readPlatformMigrationManifest(root), catalog = readPlatformMigrations(root);
  if (!raw || catalog.errors.length || evaluatePlatformMigrationManifest({ manifest: raw, migrations: catalog.migrations }).length) fail("schema_conflict");
  return installation.generation === "qualified-admin"
    ? selectPlatformMigrationManifest(raw as PlatformMigrationManifest, "qualified-admin", { roleMode: installation.roleMode })
    : selectPlatformMigrationManifest(raw as PlatformMigrationManifest, "qualified-v2", {
      migrationIsBootstrap: installation.migrationLogin === installation.bootstrapLogin, hasRestore: installation.restoreLogin !== undefined,
    });
}
function catalogPayload(client: PoolClient, installation: QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation): Promise<string> {
  return installation.generation === "qualified-admin"
    ? qualifiedAdminPostgresCatalogPayload(client, installation, migrationLock)
    : qualifiedPostgresCatalogPayload(client, installation, migrationLock);
}
async function openRestrictedOwnerWindow(client: PoolClient, installation: QualifiedAdminPostgresInstallation): Promise<void> {
  const migrator = JSON.stringify(installation.migrationLogin);
  await client.query(`GRANT platform_acquisition_owner TO ${migrator}
    WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY ${migrator}`);
  await client.query(`GRANT openlup_retained_import_owner TO ${migrator}
    WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY ${migrator}`);
}
async function closeRestrictedOwnerWindow(client: PoolClient, installation: QualifiedAdminPostgresInstallation): Promise<void> {
  const migrator = JSON.stringify(installation.migrationLogin);
  await client.query(`REVOKE openlup_retained_import_owner FROM ${migrator} GRANTED BY ${migrator}`);
  await client.query(`REVOKE platform_acquisition_owner FROM ${migrator} GRANTED BY ${migrator}`);
}
const existsCheckBatchSize = 25;

async function equalCensus(client: PoolClient, expected: Map<TableName, Rows>): Promise<boolean> {
  const nonEmpty: { sourceSql: string; rows: readonly string[] }[] = [];
  const emptySources: string[] = [];
  for (const [table, data] of expected) {
    const sourceSql = connectedStoreRowSource(table, data.columns);
    if (data.rows.length > 0) nonEmpty.push({ sourceSql, rows: data.rows });
    else emptySources.push(sourceSql);
  }
  for (const entry of nonEmpty) {
    const actual = (await client.query<{ value: string }>(`SELECT pg_catalog.to_jsonb(t)::pg_catalog.text AS value FROM ${entry.sourceSql} t`)).rows.map(row => row.value).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...entry.rows].sort())) return false;
  }
  for (let start = 0; start < emptySources.length; start += existsCheckBatchSize) {
    const batch = emptySources.slice(start, start + existsCheckBatchSize);
    const probes = batch.map((sourceSql, index) => `EXISTS (SELECT 1 FROM ${sourceSql} t LIMIT 1) AS "e${index}"`).join(",");
    const row = (await client.query<Record<string, boolean>>(`SELECT ${probes}`)).rows[0]!;
    if (batch.some((_, index) => row[`e${index}`])) return false;
  }
  return true;
}
async function assertOutsideEmpty(client: PoolClient, relations: readonly { schema: string; table: string }[],
  profileTables: readonly TableName[], replayed = false): Promise<void> {
  const outside = relations.filter(({ schema, table }) => {
    const name = `${schema}.${table}`;
    return !(schema === "public" && (profileTables.includes(table as TableName) || table === requiredPrivacyDeclarationTable))
      && !connectedStoreOutsideProfileRelations.get(name)?.preserveTarget
      && (!replayed || name !== paymentQualificationRelation);
  });
  for (let start = 0; start < outside.length; start += existsCheckBatchSize) {
    const batch = outside.slice(start, start + existsCheckBatchSize);
    const probes = batch.map((relation, index) =>
      `EXISTS (SELECT 1 FROM ${quoted(relation.schema)}.${quoted(relation.table)} LIMIT 1) AS "e${index}"`).join(",");
    const row = (await client.query<Record<string, boolean>>(`SELECT ${probes}`)).rows[0]!;
    for (let index = 0; index < batch.length; index++) {
      if (row[`e${index}`]) fail("unsupported_table", `${batch[index]!.schema}.${batch[index]!.table}`);
    }
  }
}
async function insert(client: PoolClient, table: Rows, row: string): Promise<void> {
  const name = `public.${quoted(table.table)}`, columns = table.columns.map(column => quoted(column.name)).join(",");
  const capturedSubject=table.table==='subscription_events'||table.table==='commerce_order_operations';
  const prior=capturedSubject?(await client.query("SELECT current_setting('app.communication_retained_copy',true) AS value")).rows[0]?.value:undefined;
  if(capturedSubject) await client.query("SELECT set_config('app.communication_retained_copy','on',true)");
  await client.query(`INSERT INTO ${name} (${columns}) SELECT ${columns} FROM pg_catalog.jsonb_populate_record(NULL::${name},$1::jsonb) ON CONFLICT DO NOTHING`, [row]);
  if(capturedSubject) await client.query("SELECT set_config('app.communication_retained_copy',$1,true)",[prior??'']);
  if ((await client.query(`SELECT 1 FROM ${connectedStoreRowSource(table.table, table.columns)} t WHERE pg_catalog.to_jsonb(t)=$1::jsonb`, [row])).rows.length !== 1) fail("target_conflict", table.table);
}
async function restoreSettings(client: PoolClient, baseline: Rows, source: Rows): Promise<void> {
  // Closed read-approved factory tables, including installation marking. Each deletion matches one whole
  // verified pristine row, never arbitrary existing data or an inferred diff.
  if (!settings.includes(source.table as SettingsTable) || source.table !== baseline.table) fail("invalid_input");
  for (const row of baseline.rows) {
    if ((await client.query(`DELETE FROM public.${quoted(source.table)} t WHERE pg_catalog.to_jsonb(t)=$1::jsonb RETURNING 1`, [row])).rows.length !== 1) fail("target_conflict", source.table);
  }
  for (const row of source.rows) await insert(client, source, row);
}
function parentOrder(table: TableName, rows: readonly string[]): string[] {
  const fields = table === "commerce_orders" ? ["recovery_root_order_id", "recreated_from_order_id"]
    : table === "fulfillment_shipments" ? ["replaces_shipment_id"]
      : table === "invoicing_duties" ? ["parent_duty_id"] : [];
  if (!fields.length) return [...rows];
  const pending = new Map<string, { row: string; parents: string[] }>();
  for (const row of rows) {
    // Inspect IDs only. The original PostgreSQL row text remains unchanged.
    const value = JSON.parse(row) as Record<string, unknown>;
    if (typeof value.id !== "string" || fields.some(field => value[field] !== null && typeof value[field] !== "string")
      || pending.has(value.id)) fail("target_conflict", table);
    pending.set(value.id, { row, parents: fields.flatMap(field => value[field] === null ? [] : [value[field] as string]) });
  }
  const ordered: string[] = [], done = new Set<string>(), visiting = new Set<string>();
  for (const id of pending.keys()) {
    const stack = [{ id, complete: false }];
    while (stack.length) {
      const next = stack.pop()!;
      if (done.has(next.id)) continue;
      const held = pending.get(next.id);
      if (!held || !next.complete && visiting.has(next.id)) fail("target_conflict", table);
      if (next.complete) {
        visiting.delete(next.id); done.add(next.id); ordered.push(held.row);
      } else {
        visiting.add(next.id); stack.push({ id: next.id, complete: true });
        for (const parent of [...held.parents].reverse()) stack.push({ id: parent, complete: false });
      }
    }
  }
  return ordered;
}
async function assertInsertTriggers(client: PoolClient): Promise<void> {
  const allowed = connectedStoreAllowedInsertTriggers;
  const actual = (await client.query<{ table: string; name: string }>(`SELECT c.relname AS table,t.tgname AS name FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal AND (t.tgtype & 4)<>0 AND t.tgenabled IN ('O','A')`)).rows;
  for (const trigger of actual) if (connectedNativeStoreTables.includes(trigger.table as TableName) && !allowed[trigger.table]?.includes(trigger.name)) fail("insert_trigger_requires_owner", trigger.table);
  // Full definitions/functions/roles are independently pinned by the existing
  // qualified inventory. A known name alone never attests harmless behavior.
}
async function neutralizeHistoricalNotifications(client: PoolClient, source: Map<TableName, Rows>, xid: string,
  table: "commerce_order_holds" | "shipment_external_refs"): Promise<number> {
  const keys = new Set(source.get("outbox_events")!.rows.map(row => {
    const value = JSON.parse(row) as Record<string, unknown>; return JSON.stringify([value.event_type, value.idempotency_key]);
  }));
  const hold = table === "commerce_order_holds";
  const eventType = hold ? "commerce.shipment.exception" : "commerce.shipment.dispatched";
  const noticeSource = hold ? "fulfillment_emit_shipment_exception_notification" : "fulfillment_emit_shipment_dispatched";
  const matches = hold ? `p.reason='fulfillment_exception' AND p.created_by IS NULL AND p.status='active'
      AND o.aggregate_id=p.order_id
      AND o.payload=pg_catalog.jsonb_build_object('orderUuid',p.order_id,'holdUuid',p.id,'occurredAt',p.created_at)`
    : `p.ref_role='tracking' AND p.external_id IS NOT NULL
      AND s.status IN ('handed_over','in_transit') AND s.delivered_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.fulfillment_operator_status_evidence WHERE shipment_id=s.id AND canonical_status='delivered')
      AND o.aggregate_id=s.order_id
      AND o.payload=pg_catalog.jsonb_build_object('orderUuid',s.order_id,'shipmentUuid',s.id,'occurredAt',s.handed_over_at)`;
  let removed = 0;
  for (const row of source.get(table)!.rows) {
    const value = JSON.parse(row) as Record<string, unknown>;
    if (!hold && (value.ref_role !== "tracking" || value.external_id === null)) continue;
    const key = hold ? `shipment_exception:${String(value.id)}` : `shipment_dispatched:${String(value.shipment_id)}`;
    if (keys.has(JSON.stringify([eventType, key]))) continue;
    const observed = (await client.query<{ id: string; value: string; matches: boolean }>(`SELECT o.id::pg_catalog.text AS id,
      pg_catalog.to_jsonb(o)::pg_catalog.text AS value,
      ${matches} AND o.aggregate_type='commerce_order'
      AND o.metadata=pg_catalog.jsonb_build_object('source',$5::pg_catalog.text)
      AND o.status='pending' AND o.attempts=0 AND o.processed_at IS NULL AND o.error IS NULL
      AND o.created_at=pg_catalog.transaction_timestamp() AND o.available_at=pg_catalog.transaction_timestamp()
      AND o.xmin::pg_catalog.text=pg_catalog.mod($2::pg_catalog.numeric,4294967296)::pg_catalog.int8::pg_catalog.text AS matches
      FROM public.outbox_events o,pg_catalog.jsonb_populate_record(NULL::public.${quoted(table)},$1::jsonb) p
      ${hold ? "" : "JOIN public.fulfillment_shipments s ON s.id=p.shipment_id"}
      WHERE o.event_type=$3 AND o.idempotency_key=$4`, [row, xid, eventType, key, noticeSource])).rows;
    if (!observed.length) continue;
    if (observed.length !== 1 || observed[0]!.matches !== true) fail("target_conflict", "outbox_events");
    const event = observed[0]!;
    const deleted = await client.query(`DELETE FROM public.outbox_events o WHERE o.id=$1::uuid
      AND o.event_type=$5 AND o.idempotency_key=$2
      AND pg_catalog.to_jsonb(o)=$3::jsonb
      AND o.xmin::pg_catalog.text=pg_catalog.mod($4::pg_catalog.numeric,4294967296)::pg_catalog.int8::pg_catalog.text RETURNING o.id`,
    [event.id, key, event.value, xid, eventType]);
    if (deleted.rows.length !== 1) fail("target_conflict", "outbox_events");
    removed++;
  }
  return removed;
}
function fail(code: "invalid_input" | "schema_conflict" | "target_conflict" | "unsupported_table" | "limit_exceeded" | "insert_trigger_requires_owner", table?: string): never {
  throw new PostgresTransferError(code, table);
}
