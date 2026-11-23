import { nativeCatalogPublication } from "@openlup/platform/catalog";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { createHash } from "node:crypto";
import {
  captureCompatiblePostgresRows, PostgresTransferError,
  type CompatiblePostgresPacket, type CompatiblePostgresSnapshot, type CompatiblePostgresTable,
} from "@openlup/platform/portability";

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

const owned = [
  "subscription_cancel_feedback",
  // Authoritative installation configuration with operator audit references.
  "tax_coverage_revisions",
  "commerce_promotion_definitions", "commerce_order_draft_receipts", "fulfillment_stock_operations",
  "commerce_order_adjustments", "commerce_promotion_claims", "commerce_promotion_claim_events",
  "subscription_dunning_cases", "subscription_dunning_notifications",
  "subscription_retry_obligations", "subscription_retry_receipts", "subscription_retry_recovery_authorizations",
  "commerce_checkout_recovery_tokens", "commerce_reminder_episodes", "subscription_stock_wait_cases",
  "subscription_renewal_attachments", "subscription_method_state_events", "subscription_method_states", "subscription_activations",

  // Private companion rows of the compatible payment_truth_events above.
  "payment_simulator_attempts", "payment_simulator_observations",
  "payment_provider_states", "payment_provider_attempts", "payment_provider_attempt_evidence",
  "payment_provider_receipts", "payment_provider_transitions",
  "payment_method_refs", "payment_method_ref_receipts", "payment_method_recovery_authorities",
  "payment_provider_reconciliation_runs", "payment_prepared_absence_reopens",
  "payment_dunning_case_attribution", "payment_refund_evidence",
  "commerce_destinations", "commerce_destination_bindings", "commerce_destination_v2_receipts",
  "commerce_destination_v2_documents", "commerce_destination_v2_checkout_selections", "fulfillment_parcel_contacts", "fulfillment_order_contacts", "fulfillment_contact_correction_receipts", "subscription_command_receipts", "subscription_quote_previews", "subscription_edit_quotes",
  "customer_support_subscription_commands", "customer_support_subscription_audit_events",
  "platform_human_principals", "platform_human_memberships", "platform_human_membership_audit_events",
  // AUTHORITATIVE pack metadata; no customer FK or absorption/erasure duty.
  "catalog_type_versions", "catalog_definition_installs", "catalog_tax_classes",
  "catalog_products", "catalog_product_document_revisions", "catalog_skus", "catalog_sku_identifiers",
  // Authoritative draft history and identity reservations, including abandoned drafts.
  "catalog_draft_heads", "catalog_draft_revisions", "catalog_draft_command_receipts", "catalog_draft_sku_reservations",
  // AUTHORITATIVE immutable publications, complete SKU revisions, scoped receipts and approval decisions.
  // The transient catalog_publication_pointer_capabilities table stays outside this profile;
  // the existing unknown-nonempty refusal requires it to be empty, rather than carrying authority.
  "catalog_publications", "catalog_sku_revisions", "catalog_publication_heads", "catalog_operator_receipts", "catalog_publication_decisions",
  // AUTHORITATIVE policy tuples include their original-end close marker, byte-exactly.
  "price_lists", "subscription_price_policy_revisions", "price_entries", "subscription_lines",
  "communication_event_bindings", "communication_event_receipts", "communication_event_erasures",
  "communication_recipient_consents", "communication_native_sends", "communication_native_observations", "communication_native_sync_state",
  "customer_account_consent_events", "customer_account_consent_sync_targets",
  "identity_operator_invitations", "identity_operator_invitation_events", "identity_privacy_erasures",
  "customer_subject_lifecycle_events", "customer_communication_preferences", "customer_communication_preference_events",
  "customer_account_events", "customer_saved_addresses", "customer_payment_preferences", "customer_delivery_preferences", "customer_orderer_profiles", "invoicing_buyer_snapshots",
  "commerce_operators", "commerce_order_holds", "commerce_order_operations",
  "commerce_checkout_compensations",
  "fulfillment_stock_current", "fulfillment_inventory_reservations", "fulfillment_inventory_reservation_lines", "fulfillment_purchase_reservation_receipts",
  "fulfillment_provider_archetypes", "fulfillment_ports", "fulfillment_shipments", "shipment_external_refs", "fulfillment_shipment_operations",
  "fulfillment_provider_attempts", "fulfillment_operator_attempts", "commerce_fulfillment_provider_commands", "commerce_fulfillment_provider_command_transitions",
  "fulfillment_dispatch_contexts", "fulfillment_dispatch_refs", "fulfillment_paid_handoffs", "fulfillment_observations", "fulfillment_stock_movements",
  "fulfillment_parcel_reservation_sets", "fulfillment_parcel_lines", "fulfillment_parcel_line_reservations",
  "fulfillment_operator_receipts", "fulfillment_operator_status_evidence",
  "subscription_delivery_alignment_cases", "subscription_delivery_alignment_admission_receipts", "subscription_delivery_alignment_arrivals",
  "subscriber_profiles", "subscriber_review_access_grants", "subscriber_retention_intents",
  "commerce_order_reviews", "commerce_order_review_media", "commerce_order_review_command_receipts", "commerce_order_review_audit",
  "invoicing_cutover", "invoicing_document_observations", "invoicing_delivery_receipts", "invoicing_seller_revisions",
  "platform_communication_operators", "platform_control_operators", "platform_operational_controls", "platform_control_operations",
  "platform_alerts", "platform_alert_notifications", "platform_job_controls", "platform_job_runs",
  "sales_channels", "commerce_settings", "client_absorption_policy", "subscriber_retention_activation_watermarks",
  "subscription_delivery_alignment_control", "outbox_dormant_event_types",
  "subscription_reminder_ledger", "transactional_delivery_receipts",
  "subscription_notice_refusals",
  // AUTHORITATIVE installation marking and the separate, audited baseline.
  "commerce_offer_policy_cohort_marking", "commerce_offer_policy_rollout_baselines",
  // AUTHORITATIVE catalogue-local exact-command replay evidence.
  "catalog_price_setup_receipts",
] as const;

// Intentionally not carried: single-use authorization state must stay in its
// source store. Only this exact relation receives the count-only disposition.
const intentionallyNotCarriedRelation = "public.customer_identity_challenges";

// REBUILDABLE: count only, never transport stale attribute rows as authority.
const rebuildableRelation = "public.catalog_attribute_projection";

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
  /** Actual database snapshot identity; never an object/host seal receipt. */
  observation: { cluster: string; database: string; login: string; snapshot: string };
  emptyOutsideProfile: string[];
  outsideProfileCensus: { relation: string; owner: string; rows: string;
    disposition: "unsupported-empty" | "new-target-installation-key" | "target-migration-history" | "target-address-references" | "intentionally-not-carried" | "rebuildable" }[];
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
        if (relation.schema === "acquisition_private" && (relation.table === "installation_key" || relation.table === "address_references")
          || relation.schema === "public" && relation.table === "platform_schema_migrations"
          || `${relation.schema}.${relation.table}` === intentionallyNotCarriedRelation
          || `${relation.schema}.${relation.table}` === rebuildableRelation) {
          // Count/ownership only. Never read, hash or transport installation key
          // payloads, target-owned address-reference registry rows or any challenge
          // column. Rebuildable projection contents are also excluded.
          // Private acquisition business rows below are NOT secrets by
          // naming convention: nonempty cases/history still refuse capture.
          const rows = (await db.query<{ count: string }>(`SELECT count(*)::pg_catalog.text AS count FROM ${qualified}`)).rows[0]!.count;
          outsideProfileCensus.push({ relation: `${relation.schema}.${relation.table}`, owner: relation.owner, rows,
            disposition: relation.table === "installation_key" ? "new-target-installation-key"
              : relation.table === "address_references" ? "target-address-references"
                : relation.table === "platform_schema_migrations" ? "target-migration-history"
                  : `${relation.schema}.${relation.table}` === rebuildableRelation ? "rebuildable" : "intentionally-not-carried" });
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
        compatible: packet, owned: tables,
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
