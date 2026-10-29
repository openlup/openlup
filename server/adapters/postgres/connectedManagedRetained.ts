import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import { PostgresTransferError, type CompatiblePostgresSnapshot, type TransferObject, type TransferObjectReader } from "@openlup/platform/portability";
import type { InvoiceFacts } from "@openlup/platform/invoicing/contracts";
import { mapManagedIdentityForConnectedRestore, type ManagedIdentityMappingSource } from "./connectedStoreRestore.js";
import { restoreConnectedNativeStore } from "./connectedStoreRestore.js";
import { connectedStoreClusterIdentitySql, type ConnectedNativeStoreCapture } from "./connectedStoreCapture.js";

type Row = Record<string, unknown>;
type Disposition = "requires-active-mapping" | "mapped-active-and-retained" | "retained-history" | "unsupported-empty" |
  "credential-excluded" | "service-installation-history";
export interface ManagedRetainedRow {
  source: string;
  relation: string;
  rowIdentity: string;
  subjects: string[];
  value: string;
  disposition: "requires-active-mapping" | "mapped-active-and-retained" | "retained-history";
  targetTables: string[];
  reason: string;
}
export interface ManagedRetainedCapture {
  format: "openlup.managed-retained-history.v1";
  sourceId: string;
  observation: { cluster: string; database: string; login: string; snapshot: string };
  dispositions: { relation: string; rows: number; disposition: Disposition; reason: string }[];
  rows: ManagedRetainedRow[];
  redactions: { subjectDigest: string; rows: { relation: string; rowDigest: string }[] }[];
  sha256: string;
}
export interface ManagedRetainedTransfer {
  packet: ConnectedNativeStoreCapture;
  retainedObject: ReturnType<typeof exportManagedRetainedHistory>;
  manifest: {
    format: "openlup.managed-retained-transfer.v1";
    sourceId: string;
    packetSha256: string;
    retainedKey: string;
    retainedSha256: string;
    retainedDescriptorSha256: string;
    sha256: string;
  };
}

// The positive managed profile is finite. A nonempty relation outside this
// inventory refuses; a source schema change never silently becomes an archive.
const active = new Set([
  "public.clients", "public.admin_users", "public.subscriptions", "public.subscription_cycles",
  "public.subscription_events", "public.subscription_lines", "public.commerce_orders", "public.commerce_order_items",
  "public.commerce_payments", "public.commerce_payment_intents", "public.commerce_payment_attempts",
  "public.outbox_events", "public.commerce_payment_state_transitions", "public.payment_external_refs",
  "public.accounting_invoice_issue_outbox", "public.communication_permissions",
  "public.subscription_price_agreements", "public.commerce_payment_method_refs",
  "public.identity_privacy_erasures", "public.customer_subject_lifecycle_events",
  "public.catalog_products", "public.catalog_skus", "public.price_lists", "public.price_entries",
]);
const history = new Set([
  "public.admin_audit_events", "public.customer_subject_lifecycle_events", "public.commerce_payment_reconciliation_runs",
  "public.payment_provider_settlement_batches", "public.payment_provider_settlement_items",
  "public.accounting_invoice_operations", "public.accounting_invoice_correction_outbox",
  "public.accounting_invoice_delivery_outbox", "public.communication_delivery_events",
  "public.communication_provider_events", "public.communication_email_deliveries",
  "public.subscription_dunning_cases", "public.subscription_dunning_notifications",
  "public.commerce_payment_state_transitions", "public.payment_external_refs",
  "public.commerce_payment_attempts", "public.subscription_price_agreements",
  "public.accounting_invoices", "public.commerce_idempotency_keys",
  "public.communication_contacts", "public.communication_contact_links", "public.communication_permission_events",
]);
const installation = new Set(["auth.schema_migrations", "storage.migrations", "public.schema_migrations",
  "_realtime.extensions", "_realtime.schema_migrations", "_realtime.tenants", "realtime.schema_migrations",
  "supabase_functions.migrations", "supabase_migrations.schema_migrations"]);
const credentials = new Set([
  "auth.sessions", "auth.refresh_tokens", "auth.flow_state", "auth.one_time_tokens", "auth.identities",
  "auth.mfa_factors", "auth.mfa_challenges", "auth.audit_log_entries",
]);
const metadata = new Set(["auth.users", "storage.buckets", "storage.objects"]);
const identity = /^[a-z][a-z0-9_]{0,62}$/;
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function fail(code: ConstructorParameters<typeof PostgresTransferError>[0], relation?: string): never {
  throw new PostgresTransferError(code, relation);
}
const descriptorDigest = (object: TransferObject): string => {
  try { return digest(JSON.stringify(object)); }
  catch { fail("invalid_input"); }
};
const quoted = (value: string): string => value.length <= 63 && !value.includes("\0")
  ? `"${value.replaceAll('"', '""')}"` : fail("invalid_input");

/**
 * Extract a bounded source-only record under one actual read-only snapshot.
 * Full public business rows stay private in the sidecar. Auth credentials are
 * never selected; the selected Auth/Storage metadata must be reconciled with
 * their owning APIs by the host before object publication.
 */
export async function captureManagedRetainedHistory(input: {
  source: CompatiblePostgresSnapshot;
  sourceId: string;
  maximumRows: number;
  maximumBytes: number;
}): Promise<ManagedRetainedCapture> {
  if (typeof input.sourceId !== "string" || !input.sourceId || input.sourceId.length > 1024
    || !Number.isSafeInteger(input.maximumRows) || input.maximumRows < 1 || input.maximumRows > 10000
    || !Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1 || input.maximumBytes > 64 * 1024 * 1024) fail("invalid_input");
  try {
    return await input.source.withSnapshot(async db => {
      const facts = (await db.query<{ readonly: string; isolation: string; cluster: string; database: string; login: string; snapshot: string }>(
        `SELECT pg_catalog.current_setting('transaction_read_only') AS readonly,
          pg_catalog.current_setting('transaction_isolation') AS isolation,
          ${connectedStoreClusterIdentitySql} AS cluster,
          pg_catalog.current_database() AS database,session_user::pg_catalog.text AS login,
          pg_catalog.txid_current_snapshot()::pg_catalog.text AS snapshot`)).rows[0];
      if (facts?.readonly !== "on" || facts.isolation !== "repeatable read") fail("invalid_input");
      await db.query("SET LOCAL TimeZone = 'UTC'");
      const relations = (await db.query<{ schema: string; table: string }>(`SELECT n.nspname AS schema,c.relname AS table
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE pg_catalog.left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
          AND c.relkind IN ('r','p')
        ORDER BY n.nspname,c.relname`)).rows;
      const sourceRows = new Map<string, Row[]>();
      const sourceRaw = new Map<string, { value: string; rowIdentity: string }[]>();
      const dispositions: ManagedRetainedCapture["dispositions"] = [];
      let totalRows = 0, totalBytes = 0;
      for (const relation of relations) {
        const name = `${relation.schema}.${relation.table}`;
        const qualified = `${quoted(relation.schema)}.${quoted(relation.table)}`;
        if (credentials.has(name) || installation.has(name)) {
          const rows = Number((await db.query<{ count: string }>(`SELECT count(*)::pg_catalog.text AS count FROM ${qualified}`)).rows[0]?.count);
          if (!Number.isSafeInteger(rows)) fail("limit_exceeded", name);
          dispositions.push({ relation: name, rows, disposition: credentials.has(name) ? "credential-excluded" : "service-installation-history",
            reason: credentials.has(name) ? "sessions and authentication secrets require new target login" : "target service owns its installation history" });
          continue;
        }
        if (!active.has(name) && !history.has(name) && !metadata.has(name)) {
          if ((await db.query(`SELECT 1 FROM ${qualified} LIMIT 1`)).rows.length) fail("unsupported_table", name);
          dispositions.push({ relation: name, rows: 0, disposition: "unsupported-empty", reason: "no source class mapping" });
          continue;
        }
        // Auth's metadata projection is deliberately narrower than auth.users;
        // no password, token or provider credential enters the manifest. Storage
        // rows are complete because their metadata/ownership is transfer data.
        const expression = name === "auth.users"
          ? "pg_catalog.jsonb_build_object('id',t.id,'email',t.email,'created_at',t.created_at,'updated_at',t.updated_at)"
          : "pg_catalog.to_jsonb(t)";
        const keyColumns = (await db.query<{ name: string }>(`SELECT a.attname AS name
          FROM pg_catalog.pg_index i
          CROSS JOIN LATERAL pg_catalog.unnest(i.indkey) WITH ORDINALITY k(attnum,ordinal)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
          WHERE i.indrelid=$1::pg_catalog.regclass AND i.indisprimary ORDER BY k.ordinal`, [qualified])).rows;
        if (!keyColumns.length) fail("schema_conflict", name);
        const key = `pg_catalog.jsonb_build_array(${keyColumns.map(column => `t.${quoted(column.name)}`).join(",")})::pg_catalog.text`;
        const raw = (await db.query<{ value: string; row_identity: string }>(`SELECT (${expression})::pg_catalog.text AS value,
          ${key} AS row_identity FROM ${qualified} t ORDER BY (${expression})::pg_catalog.text LIMIT $1`,
        [input.maximumRows + 1])).rows.map(row => ({ value: row.value, rowIdentity: row.row_identity }));
        totalRows += raw.length; totalBytes += raw.reduce((sum, row) => sum + Buffer.byteLength(row.value), 0);
        if (totalRows > input.maximumRows || totalBytes > input.maximumBytes) fail("limit_exceeded", name);
        sourceRows.set(name, raw.map(row => JSON.parse(row.value) as Row));
        sourceRaw.set(name, raw);
        dispositions.push({ relation: name, rows: raw.length, disposition: active.has(name) || name === "auth.users"
          ? "requires-active-mapping" : "retained-history", reason: active.has(name) ? "canonical projection required before publication"
          : name === "auth.users" ? "identity metadata only; credentials excluded" : "full private source history or object metadata" });
      }
      const subjects = subjectOwners(sourceRows);
      const rows: ManagedRetainedRow[] = [];
      for (const [relation, values] of sourceRows) {
        for (const [index, value] of values.entries()) {
          const rowIdentity = sourceRaw.get(relation)![index]!.rowIdentity;
          const anchors = subjects(relation, value);
          if (anchors === null) fail("invalid_input", relation);
          const needsMapping = active.has(relation) || relation === "auth.users";
          rows.push({ source: input.sourceId, relation, rowIdentity, subjects: anchors.sort(),
            value: sourceRaw.get(relation)![index]!.value, disposition: needsMapping ? "requires-active-mapping" : "retained-history",
            targetTables: [], reason: needsMapping ? "canonical target row required before publication" : "private historical metadata" });
        }
      }
      rows.sort((left, right) => JSON.stringify([left.relation,left.rowIdentity]).localeCompare(JSON.stringify([right.relation,right.rowIdentity])));
      if (new Set(rows.map(row => JSON.stringify([row.relation,row.rowIdentity]))).size !== rows.length) fail("target_conflict");
      const body = { format: "openlup.managed-retained-history.v1" as const, sourceId: input.sourceId,
        observation: { cluster: facts.cluster, database: facts.database, login: facts.login, snapshot: facts.snapshot }, dispositions, rows,
        redactions: [] as ManagedRetainedCapture["redactions"] };
      return { ...body, sha256: digest(JSON.stringify(body)) };
    });
  } catch (error) { if (error instanceof PostgresTransferError) throw error; fail("database_unavailable"); }
}

function subjectOwners(all: Map<string, Row[]>): (relation: string, row: Row) => string[] | null {
  const clients = new Map(all.get("public.clients")?.map(row => [row.id, row]) ?? []);
  const subscriptions = new Map(all.get("public.subscriptions")?.map(row => [row.id, row]) ?? []);
  const orders = new Map(all.get("public.commerce_orders")?.map(row => [row.id, row]) ?? []);
  const intents = new Map(all.get("public.commerce_payment_intents")?.map(row => [row.id, row]) ?? []);
  const payments = new Map(all.get("public.commerce_payments")?.map(row => [row.id, row]) ?? []);
  const invoices = new Map(all.get("public.accounting_invoices")?.map(row => [row.id, row]) ?? []);
  const contacts = new Map(all.get("public.communication_contacts")?.map(row => [row.id, row]) ?? []);
  const contactOwners = new Map<unknown, string[]>();
  for (const row of all.get("public.communication_contact_links") ?? []) {
    if (row.source_table !== "clients" || typeof row.source_id !== "string" || !clients.has(row.source_id)) continue;
    contactOwners.set(row.contact_id, [...new Set([...(contactOwners.get(row.contact_id) ?? []), row.source_id])]);
  }
  const byClient = (id: unknown): string[] | null => {
    if (typeof id !== "string") return null;
    const client = clients.get(id);
    if (!client) return null;
    return typeof client.auth_user_id === "string" ? [id, client.auth_user_id] : [id];
  };
  const bySubscription = (id: unknown): string[] | null => byClient(subscriptions.get(id)?.client_id);
  const byOrder = (id: unknown): string[] | null => byClient(orders.get(id)?.client_id);
  const byIntent = (id: unknown): string[] | null => byOrder(intents.get(id)?.order_id);
  const byPayment = (id: unknown): string[] | null => byOrder(payments.get(id)?.order_id);
  const byInvoice = (id: unknown): string[] | null => byOrder(invoices.get(id)?.order_id);
  const byContact = (id: unknown): string[] | null => {
    if (!contacts.has(id)) return null;
    const linked = contactOwners.get(id);
    return linked ? [...new Set(linked.flatMap(clientId => byClient(clientId) ?? []))] : null;
  };
  const settlementItems = all.get("public.payment_provider_settlement_items") ?? [];
  const bySettlementItem = (row: Row): string[] | null => byIntent(row.payment_intent_id)
    ?? byPayment(row.payment_id) ?? byInvoice(row.invoice_id);
  return (relation, row) => {
    if (relation === "public.clients") return byClient(row.id);
    if (relation === "auth.users") return typeof row.id === "string" ? [row.id] : null;
    if (relation === "public.admin_users") return typeof row.id === "string" ? [row.id] : null;
    if (relation === "public.admin_audit_events") {
      if (typeof row.actor_admin_id !== "string") return null;
      const owners = [row.actor_admin_id];
      if (typeof row.target_admin_id === "string") owners.push(row.target_admin_id);
      if (row.action === "customer_read") {
        if (typeof row.entity_id !== "string" || !clients.has(row.entity_id)) return null;
        owners.push(...byClient(row.entity_id)!);
      }
      return [...new Set(owners)];
    }
    if (relation === "public.identity_privacy_erasures") {
      if (typeof row.actor_principal_id !== "string") return null;
      const owners = [row.actor_principal_id];
      if (typeof row.principal_id === "string") owners.push(row.principal_id);
      if (typeof row.client_id === "string") owners.push(row.client_id);
      return [...new Set(owners)];
    }
    if (relation === "public.customer_subject_lifecycle_events") return byClient(row.client_id);
    if (relation === "public.subscriptions") return bySubscription(row.id);
    if (relation.startsWith("public.subscription_")) return bySubscription(row.subscription_id);
    if (relation === "public.commerce_orders") return byOrder(row.id);
    if (relation === "public.commerce_order_items" || relation === "public.commerce_payments") return byOrder(row.order_id);
    if (relation === "public.commerce_payment_intents") return byOrder(row.order_id);
    if (relation === "public.commerce_payment_attempts" || relation === "public.commerce_payment_state_transitions") return byIntent(row.payment_intent_id);
    if (relation === "public.payment_external_refs") return byPayment(row.payment_id);
    if (relation === "public.commerce_payment_method_refs") return byClient(row.client_id);
    if (relation === "public.commerce_payment_reconciliation_runs") return byIntent(row.payment_intent_id);
    if (relation === "public.payment_provider_settlement_items") return bySettlementItem(row);
    if (relation === "public.payment_provider_settlement_batches") {
      const items = settlementItems.filter(item => item.batch_id === row.id);
      if (!items.length) return null;
      const owners = items.map(bySettlementItem);
      return owners.some(owner => owner === null) ? null : [...new Set(owners.flatMap(owner => owner!))];
    }
    if (relation === "public.commerce_idempotency_keys") {
      if (row.status === "in_progress" || row.metadata === null || typeof row.metadata !== "object"
        || Array.isArray(row.metadata)) return null;
      return byClient((row.metadata as Row).clientId);
    }
    if (relation === "public.accounting_invoices") return byInvoice(row.id);
    if (relation.startsWith("public.accounting_invoice_")) return byInvoice(row.invoice_id);
    if (relation === "public.communication_contacts" || relation === "public.communication_contact_links"
      || relation === "public.communication_permissions" || relation === "public.communication_permission_events") {
      return byContact(relation === "public.communication_contacts" ? row.id : row.contact_id);
    }
    if (relation === "public.communication_provider_events") {
      if (row.contact_id !== null) return byContact(row.contact_id);
      const matches = [...contacts.values()].filter(contact => contact.normalized_email === row.normalized_email);
      return matches.length === 1 ? byContact(matches[0]!.id) : null;
    }
    if (relation === "public.communication_email_deliveries") return row.client_id !== null
      ? byClient(row.client_id) : row.contact_id !== null ? byContact(row.contact_id)
        : typeof row.auth_user_id === "string" ? [row.auth_user_id] : null;
    if (relation === "public.catalog_products" || relation === "public.catalog_skus"
      || relation === "public.price_lists" || relation === "public.price_entries") return [];
    if (relation === "public.outbox_events") return row.aggregate_type === "subscription" ? bySubscription(row.aggregate_id)
      : row.aggregate_type === "commerce_order" ? byOrder(row.aggregate_id) : null;
    if (relation === "storage.buckets") return [];
    if (relation === "storage.objects") return typeof row.owner_id === "string" && row.owner_id ? [row.owner_id] : null;
    return null;
  };
}

/** Read #428's finite identity input from the captured managed Auth/business rows. */
export function managedIdentityEvidence(capture: ManagedRetainedCapture, issuer: string): ManagedIdentityMappingSource {
  validate(capture);
  const values = (relation: string): Row[] => capture.rows.filter(row => row.relation === relation)
    .map(row => JSON.parse(row.value) as Row);
  const clients = values("public.clients"), adminUsers = values("public.admin_users"), authUsers = values("auth.users"),
    erasures = values("public.identity_privacy_erasures");
  const linked = new Set<string>();
  for (const row of clients) if (typeof row.auth_user_id === "string") linked.add(row.auth_user_id);
  for (const row of adminUsers) if (typeof row.id === "string") linked.add(row.id);
  const subjects: { managedId: string; subject: string }[] = [];
  for (const row of authUsers) {
    if (typeof row.id !== "string" || !linked.has(row.id) || typeof row.email !== "string") fail("invalid_input", "auth.users");
    const client = clients.find(value => value.auth_user_id === row.id);
    const admin = adminUsers.find(value => value.id === row.id);
    if (client && client.email !== row.email || admin && admin.email !== row.email) fail("target_conflict", "auth.users");
    subjects.push({ managedId: row.id, subject: row.id });
  }
  for (const row of erasures) if (typeof row.principal_id === "string"
    && !subjects.some(subject => subject.managedId === row.principal_id)) {
    // A completed erasure can delete its Auth user. The immutable erasure
    // receipt is the remaining explicit managed-subject provenance.
    subjects.push({ managedId: row.principal_id, subject: row.principal_id });
    linked.add(row.principal_id);
  }
  if (subjects.length !== linked.size) fail("invalid_input", "auth.users");
  const revokeAudit = values("public.admin_audit_events").filter(row => row.action === "revoke");
  return { sourceId: capture.sourceId, issuer, observation: capture.observation, subjects,
    clients, adminUsers, revokeAudit, erasures,
    lifecycleEvents: values("public.customer_subject_lifecycle_events") };
}

/**
 * A deliberately narrow managed money projection. Unsafe external attempts and
 * unsupported active row classes refuse before any target restore can begin.
 * Every source row still stays in the retained-history object for readback.
 */
export async function mapManagedRetainedBusiness(input: {
  capture: ManagedRetainedCapture;
  issuer: string;
  freshTarget: ConnectedNativeStoreCapture;
  targetOwner: Pool;
}): Promise<{ packet: ConnectedNativeStoreCapture; retained: ManagedRetainedCapture }> {
  validate(input.capture);
  const identitySource = managedIdentityEvidence(input.capture, input.issuer);
  const mapped = await mapManagedIdentityForConnectedRestore({ source: identitySource,
    freshTarget: input.freshTarget, targetOwner: input.targetOwner });
  const packet = mapped.packet;
  const values = (relation: string): Row[] => input.capture.rows.filter(row => row.relation === `public.${relation}`)
    .map(row => JSON.parse(row.value) as Row);
  const byId = (rows: Row[]) => new Map(rows.map(row => [row.id, row]));
  const project = (table: string, row: Row, overrides: Row = {}): Row => {
    const held = packet.compatible.tables.find(value => value.table === table)
      ?? packet.owned.find(value => value.table === table);
    if (!held) fail("schema_conflict", table);
    const result = Object.fromEntries(held.columns.map(column => [column.name,
      Object.hasOwn(overrides, column.name) ? overrides[column.name] : row[column.name]]));
    if (Object.values(result).some(value => value === undefined)) fail("schema_conflict", table);
    return result;
  };
  const products = values("catalog_products"), skus = values("catalog_skus"), priceLists = values("price_lists"),
    priceEntries = values("price_entries"), subscriptions = values("subscriptions"),
    subscriptionLines = values("subscription_lines"), agreements = values("subscription_price_agreements"),
    methods = values("commerce_payment_method_refs"), cycles = values("subscription_cycles"),
    subscriptionEvents = values("subscription_events");
  const contacts = values("communication_contacts"), contactLinks = values("communication_contact_links"),
    permissions = values("communication_permissions");
  const orders = values("commerce_orders"), items = values("commerce_order_items"), payments = values("commerce_payments"),
    intents = values("commerce_payment_intents"), attempts = values("commerce_payment_attempts"),
    transitions = values("commerce_payment_state_transitions"), outbox = values("outbox_events");
  const invoices = values("accounting_invoices"), issueOutbox = values("accounting_invoice_issue_outbox");
  const orderById = byId(orders), paymentById = byId(payments);
  const projected: Record<string, Row[]> = { catalog_products: [], catalog_skus: [], price_lists: [], price_entries: [],
    subscriptions: [], subscription_lines: [], subscription_cycles: [], subscription_events: [], subscription_renewal_terms: [],
    subscription_renewal_term_lines: [], commerce_orders: [], commerce_order_items: [],
    commerce_settlement_intents: [], commerce_settlement_transitions: [], outbox_events: [],
    invoicing_duties: [], invoicing_fact_revisions: [], invoicing_effect_receipts: [],
    communication_recipient_consents: [] };
  for (const row of products) projected.catalog_products!.push(project("catalog_products", row));
  for (const row of skus) projected.catalog_skus!.push(project("catalog_skus", row));
  for (const row of priceLists) projected.price_lists!.push(project("price_lists", row));
  for (const row of priceEntries) projected.price_entries!.push(project("price_entries", row));
  const skuById = byId(skus), subscriptionById = byId(subscriptions);
  for (const row of subscriptions) {
    if (row.status !== "active" || row.pet_id !== null
      || row.shipping_address_id !== null || row.billing_address_id !== null || row.edit_window_hours === null
      || row.payment_method_kind !== null && row.payment_method_kind !== "card" && row.payment_method_kind !== "blik_payid")
      fail("unsupported_table", "public.subscriptions");
    const lists = priceLists.filter(list => list.status === "active" && list.region_code === row.region_code
      && list.currency === row.currency && typeof list.valid_from === "string"
      && Date.parse(list.valid_from) <= Date.parse(String(row.next_cycle_at))
      && (list.valid_to === null || Date.parse(String(row.next_cycle_at)) < Date.parse(String(list.valid_to))));
    if (lists.length !== 1) fail("target_conflict", "public.price_lists");
    projected.subscriptions!.push(project("subscriptions", row, { price_list_id: lists[0]!.id, currency_code: row.currency }));
    const currentLines = subscriptionLines.filter(line => line.subscription_id === row.id);
    const activeMethods = methods.filter(method => method.subscription_id === row.id && method.status === "active" && method.active === true);
    if (!currentLines.length || activeMethods.length !== 1) fail("target_conflict", "public.subscriptions");
    const method = activeMethods[0]!, consent = method.consent_snapshot as Row;
    if (!consent || typeof consent !== "object" || Array.isArray(consent) || consent.recurringModel !== "O"
      || typeof consent.acceptedAt !== "string" || !Number.isFinite(Date.parse(consent.acceptedAt))
      || typeof method.provider_mandate_ref !== "string" || !method.provider_mandate_ref
      || typeof method.provider_kind !== "string" || method.provider_kind.length > 64
      || method.client_id !== row.client_id || method.provider_method_ref !== row.payment_method_ref)
      fail("target_conflict", "public.commerce_payment_method_refs");
    const currentCycles = cycles.filter(cycle => cycle.subscription_id === row.id);
    if (currentCycles.some(cycle => typeof cycle.cycle_number !== "number" || cycle.cycle_number < 0))
      fail("invalid_input", "public.subscription_cycles");
    const nextCycleNumber = Math.max(0, ...currentCycles.map(cycle => Number(cycle.cycle_number))) + 1;
    const stockSku = currentLines.length === 1 ? skuById.get(currentLines[0]!.variant_id)?.sku : null;
    if (typeof stockSku !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(stockSku))
      fail("unsupported_table", "public.subscription_lines");
    projected.subscription_renewal_terms!.push({ subscription_id: row.id, next_cycle_number: nextCycleNumber,
      currency_code: row.currency, stock_source_key: stockSku, settlement_channel_key: method.provider_kind,
      unattended_charge_authorized_at: consent.acceptedAt, authorization_ref: method.provider_mandate_ref,
      payer_account_ref: method.provider_customer_ref, delivery_admission: "blocked",
      delivery_block_reason: "managed-source-address-binding-required", created_at: row.created_at, updated_at: row.updated_at });
  }
  for (const row of subscriptionLines) {
    const subscription = subscriptionById.get(row.subscription_id), sku = skuById.get(row.variant_id);
    const current = agreements.filter(agreement => agreement.subscription_line_id === row.id && agreement.ended_at === null);
    if (!subscription || !sku || current.length !== 1 || row.template_version !== subscription.template_version
      || current[0]!.template_version !== row.template_version || current[0]!.currency !== subscription.currency
      || typeof current[0]!.unit_price_gross_minor !== "number" || current[0]!.unit_price_gross_minor < 0)
      fail("target_conflict", "public.subscription_price_agreements");
    const agreement = current[0]!;
    projected.subscription_lines!.push(project("subscription_lines", row, { quantity: row.qty,
      unit_price_minor: agreement.unit_price_gross_minor, currency_code: agreement.currency }));
    projected.subscription_renewal_term_lines!.push({ subscription_id: row.subscription_id,
      line_ordinal: Number(row.sort_order) + 1, sku: sku.sku, quantity: row.qty,
      unit_amount_minor: agreement.unit_price_gross_minor, created_at: row.created_at, updated_at: row.updated_at });
  }
  if (agreements.some(row => row.ended_at === null && !subscriptionLines.some(line => line.id === row.subscription_line_id))
    || methods.some(row => row.status === "active" && row.active === true && !subscriptionById.has(row.subscription_id)))
    fail("unsupported_table", "public.subscription_price_agreements");
  for (const row of cycles) {
    if (!subscriptionById.has(row.subscription_id) || row.scheduled_at === null
      || !["planned", "payment_pending", "paid", "cancelled"].includes(String(row.status))
      || row.retry_attempt !== 0 || row.provider_attempt_sequence !== 0 || row.next_retry_at !== null
      || row.renewal_quarantined_until !== null || row.renewal_row_error_count !== 0)
      fail("unsupported_table", "public.subscription_cycles");
    projected.subscription_cycles!.push(project("subscription_cycles", row,
      { renewal_operation_id: null, renewal_operation_fingerprint: null }));
  }
  for (const row of subscriptionEvents) {
    if (!subscriptionById.has(row.subscription_id) || typeof row.idempotency_key !== "string" || !row.idempotency_key)
      fail("target_conflict", "public.subscription_events");
    projected.subscription_events!.push(project("subscription_events", row));
  }
  const contactById = byId(contacts), consentKeys = new Set<string>();
  for (const row of permissions) {
    const contact = contactById.get(row.contact_id);
    const links = contactLinks.filter(link => link.contact_id === row.contact_id);
    if (!contact || typeof contact.normalized_email !== "string" || !links.length
      || links.some(link => link.source_table !== "clients" || !identitySource.clients.some(client => client.id === link.source_id))
      || !["granted", "denied", "suppressed"].includes(String(row.state)) || row.channel !== "email")
      fail("unsupported_table", "public.communication_permissions");
    const fingerprint = digest(contact.normalized_email), key = JSON.stringify([fingerprint,row.purpose]);
    if (consentKeys.has(key)) fail("target_conflict", "public.communication_permissions");
    consentKeys.add(key);
    projected.communication_recipient_consents!.push({ recipient_fingerprint: fingerprint,
      purpose: row.purpose, state: row.state, captured_at: row.captured_at, updated_at: row.updated_at });
  }
  for (const row of orders) {
    if (!["pending_payment", "paid"].includes(String(row.status)) || row.mode !== "one_time" || typeof row.client_id !== "string"
      || row.discount_cents !== 0 || row.shipping_cents !== 0 || row.shipping_discount_cents !== 0
      || row.source_kind !== "storefront" || row.source_channel_id !== null || row.source_order_ref !== null
      || row.subscription_id !== null || row.subscription_cycle_id !== null || row.recovery_root_order_id !== null
      || row.recreated_from_order_id !== null || row.shipping_address_id !== null || row.pet_id !== null
      || typeof row.total_cents !== "number" || !Number.isSafeInteger(row.total_cents)) fail("unsupported_table", "public.commerce_orders");
    const lines = items.filter(item => item.order_id === row.id);
    if (!lines.length || lines.some(item => item.discount_allocated_cents !== 0 || item.total_cents !== item.effective_total_cents
      || item.quantity !== 1 && item.total_cents !== Number(item.unit_price_cents) * Number(item.quantity))
      || lines.reduce((sum, item) => sum + Number(item.total_cents), 0) !== row.total_cents) fail("target_conflict", "public.commerce_order_items");
    const paidIntents = intents.filter(intent => intent.order_id === row.id && intent.status === "succeeded");
    if (row.status === "paid" ? paidIntents.length !== 1 : paidIntents.length !== 0)
      fail("target_conflict", "public.commerce_payment_intents");
    projected.commerce_orders!.push({ id: row.id, subscription_cycle_id: null, status: row.status,
      created_at: row.created_at, updated_at: row.updated_at, client_id: row.client_id,
      paid_at: row.status === "paid" ? paidIntents[0]!.updated_at : null,
      cancelled_at: null, refunded_at: null, metadata: row.metadata,
      currency_code: row.currency, total_amount_minor: row.total_cents, source_kind: row.source_kind,
      source_channel_id: null, source_order_ref: null, renewal_operation_id: null, renewal_operation_fingerprint: null });
  }
  for (const row of items) {
    if (!orderById.has(row.order_id) || typeof row.allocation_ordinal !== "number"
      || typeof row.total_cents !== "number" || row.total_cents !== Number(row.unit_price_cents) * Number(row.quantity))
      fail("target_conflict", "public.commerce_order_items");
    projected.commerce_order_items!.push({ id: row.id, order_id: row.order_id, sku_id: row.sku_id,
      line_ordinal: row.allocation_ordinal, quantity: row.quantity, unit_amount_minor: row.unit_price_cents,
      line_amount_minor: row.total_cents, created_at: row.created_at, source_line_ordinal: null,
      catalog_unit_amount_minor: null, catalog_line_amount_minor: null,
      promotion_discount_allocated_minor: null, promotion_allocation_fingerprint: null });
  }
  const intentById = byId(intents);
  const targetTransitionKey = (rowId: unknown) =>
    `managed-transfer-transition:${digest(JSON.stringify([input.capture.sourceId,rowId]))}`;
  for (const row of intents) {
    const order = orderById.get(row.order_id), payment = paymentById.get(row.payment_id);
    const ownAttempts = attempts.filter(attempt => attempt.payment_intent_id === row.id);
    const ownTransitions = transitions.filter(transition => transition.payment_intent_id === row.id);
    if (!order || !payment || payment.order_id !== row.order_id || row.target_kind !== "one_time_order"
      || row.subscription_id !== null || row.subscription_cycle_id !== null
      || !["created", "failed", "succeeded"].includes(String(row.status))
      || row.amount_cents !== order.total_cents || row.amount_cents !== payment.amount_cents
      || row.currency !== order.currency || row.currency !== payment.currency
      || typeof payment.provider !== "string" || !payment.provider || payment.provider.length > 64
      || (row.status === "created" && (payment.status !== "pending" || ownAttempts.length || ownTransitions.length))
      || (row.status === "failed" && (payment.status !== "failed" || ownAttempts.length !== 1
        || ownAttempts[0]?.status !== "failed" || ownTransitions.length !== 1 || ownTransitions[0]?.to_status !== "failed"))
      || (row.status === "succeeded" && (order.status !== "paid" || payment.status !== "succeeded"
        || ownAttempts.length !== 1 || ownAttempts[0]?.status !== "succeeded" || ownTransitions.length !== 1
        || ownTransitions[0]?.to_status !== "succeeded" || typeof row.provider_payment_id !== "string"
        || !row.provider_payment_id)))
      fail("target_conflict", "public.commerce_payment_intents");
    projected.commerce_settlement_intents!.push({ id: row.id, order_id: row.order_id,
      channel_key: payment.provider, status: row.status === "succeeded" ? "settled" : row.status, amount_minor: row.amount_cents,
      currency_code: row.currency, external_ref: row.provider_payment_id,
      open_idempotency_key: `managed-transfer-open:${digest(JSON.stringify([input.capture.sourceId,row.id]))}`,
      settled_at: row.status === "succeeded" ? row.updated_at : null,
      failure_reason: row.failure_reason, created_at: row.created_at, updated_at: row.updated_at,
      renewal_operation_id: null, renewal_operation_fingerprint: null });
    if (row.status === "failed" || row.status === "succeeded") {
      const transition = ownTransitions[0]!;
      projected.commerce_settlement_transitions!.push({ id: transition.id, intent_id: row.id,
        from_status: "created", to_status: row.status === "succeeded" ? "settled" : "failed",
        outcome: row.status === "succeeded" ? "succeeded" : "failed",
        idempotency_key: targetTransitionKey(transition.id),
        payload: { sourceId: input.capture.sourceId, sourceRowId: transition.id }, occurred_at: transition.occurred_at });
    }
  }
  if (payments.some(row => !intents.some(intent => intent.payment_id === row.id))
    || attempts.some(row => !intentById.has(row.payment_intent_id) || !["failed", "succeeded"].includes(String(row.status)))
    || transitions.some(row => !intentById.has(row.payment_intent_id))) fail("unsupported_table", "public.commerce_payments");
  for (const row of outbox) {
    if (["processed", "discarded"].includes(String(row.status))) continue;
    const order = orderById.get(row.aggregate_id), subscription = subscriptionById.get(row.aggregate_id);
    const payload = row.payload as Row | null;
    const paidFulfillment = row.event_type === "commerce.order.paid" && row.aggregate_type === "commerce_order"
      && order?.status === "paid" && payload?.orderUuid === row.aggregate_id;
    const subscriptionWelcome = row.event_type === "subscription.created" && row.aggregate_type === "subscription"
      && subscription?.status === "active" && payload?.subscriptionId === row.aggregate_id
      && payload?.clientId === subscription.client_id;
    if (row.status !== "pending" || row.attempts !== 0 || !payload || typeof payload !== "object"
      || Array.isArray(payload) || !paidFulfillment && !subscriptionWelcome)
      fail("unsupported_table", "public.outbox_events");
    projected.outbox_events!.push(project("outbox_events", row));
  }
  for (const delivery of values("communication_email_deliveries")) {
    const work = outbox.find(row => row.id === delivery.outbox_event_id);
    if (!work || work.event_type !== delivery.trigger_event || work.aggregate_type !== delivery.aggregate_type
      || String(work.aggregate_id) !== delivery.aggregate_id
      || delivery.email_send_id !== null || delivery.provider_message_id !== null
      || delivery.attempt_count !== 0 || !(delivery.status === "planned" && work.status === "pending"
        || delivery.status === "failed" && work.status === "discarded"))
      fail("unsupported_table", "public.communication_email_deliveries");
  }
  const invoiceById = byId(invoices);
  for (const work of issueOutbox) {
    const invoice = invoiceById.get(work.invoice_id), order = invoice && orderById.get(invoice.order_id);
    const paidIntent = invoice && intents.find(intent => intent.order_id === invoice.order_id && intent.status === "succeeded");
    const paidTransition = paidIntent && transitions.find(transition =>
      transition.payment_intent_id === paidIntent.id && transition.to_status === "succeeded");
    const matchedSettlement = paidIntent && values("payment_provider_settlement_items").filter(item =>
      item.payment_intent_id === paidIntent.id && item.provider_payment_id === paidIntent.provider_payment_id
      && item.status === "matched" && item.gross_cents === paidIntent.amount_cents);
    const rawLines = invoice?.lines_snapshot;
    if (!invoice || !order || order.status !== "paid" || !paidIntent || !paidTransition
      || typeof paidTransition.idempotency_key !== "string" || !paidTransition.idempotency_key
      || matchedSettlement?.length !== 1
      || work.status !== "pending"
      || work.attempt_count !== 0 || work.processed_at !== null
      || work.next_attempt_at !== null && work.next_attempt_at !== undefined
      || invoice.status !== "issue_requested" || invoice.provider_kind !== work.provider_kind
      || invoice.provider_invoice_id !== null || invoice.provider_invoice_number !== null
      || invoice.ksef_number !== null || invoice.ksef_required !== false
      || invoice.ksef_status !== "not_submitted" || invoice.correction_status !== "none"
      || invoice.correction_of_invoice_id !== null || invoice.provider_pdf_ref !== null
      || invoice.provider_xml_ref !== null || invoice.provider_upo_ref !== null
      || invoice.document_type !== "b2c_invoice" || invoice.document_kind !== null
      || invoice.policy_version !== "invoicing.seller.v1" || invoice.currency !== order.currency
      || invoice.total_gross_cents !== order.total_cents || invoice.payment_completed_at !== paidIntent.updated_at
      || invoice.provider_payment_id !== paidIntent.provider_payment_id
      || !Array.isArray(rawLines) || !rawLines.length
      || !invoice.buyer_snapshot || typeof invoice.buyer_snapshot !== "object" || Array.isArray(invoice.buyer_snapshot)
      || typeof invoice.invoice_ref !== "string" || !invoice.invoice_ref)
      fail("unsupported_table", "public.accounting_invoice_issue_outbox");
    const lines = rawLines.map(raw => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("invalid_input", "public.accounting_invoices");
      const line = raw as Row;
      const gross = line.totalGrossMinor, net = line.totalNetMinor;
      if (typeof gross !== "number" || typeof net !== "number" || !Number.isSafeInteger(gross)
        || !Number.isSafeInteger(net) || net < 0 || gross < net || typeof line.name !== "string" || !line.name
        || typeof line.quantity !== "number" || !Number.isSafeInteger(line.quantity) || line.quantity < 1
        || typeof line.unitNetMinor !== "number" || !Number.isSafeInteger(line.unitNetMinor)
        || typeof line.unitGrossMinor !== "number" || !Number.isSafeInteger(line.unitGrossMinor)
        || typeof line.vatRateBps !== "number" || !Number.isSafeInteger(line.vatRateBps))
        fail("target_conflict", "public.accounting_invoices");
      return { quantity: line.quantity, unitNetMinor: line.unitNetMinor, unitGrossMinor: line.unitGrossMinor,
        totalGrossMinor: gross, totalNetMinor: net, totalTaxMinor: gross - net,
        taxRateBps: line.vatRateBps, description: line.name, positionKind: "item" as const,
        catalogTotalGrossMinor: null, discountAllocatedMinor: null, shippingGrossMinor: null,
        shippingDiscountMinor: null };
    });
    const gross = lines.reduce((sum, line) => sum + line.totalGrossMinor, 0);
    const net = lines.reduce((sum, line) => sum + line.totalNetMinor, 0);
    if (gross !== invoice.total_gross_cents || net !== invoice.total_net_cents
      || !invoice.tax_snapshot || typeof invoice.tax_snapshot !== "object"
      || (invoice.tax_snapshot as Row).taxCents !== gross - net) fail("target_conflict", "public.accounting_invoices");
    const buyer = invoice.buyer_snapshot as Row;
    if (typeof buyer.name !== "string" || !buyer.name || typeof buyer.email !== "string"
      || typeof invoice.created_at !== "string" || !Number.isFinite(Date.parse(invoice.created_at))
      || typeof order.subtotal_cents !== "number" || typeof order.discount_cents !== "number"
      || typeof order.shipping_cents !== "number" || typeof order.shipping_discount_cents !== "number")
      fail("target_conflict", "public.accounting_invoices");
    const facts: InvoiceFacts = {
      factRevision: `managed-invoice:${invoice.id}`, policyVersion: String(invoice.policy_version),
      documentKind: "b2c_named", clearanceRequired: false,
      refs: { orderId: String(invoice.order_id), orderRef: String(invoice.order_ref), invoiceRef: String(invoice.invoice_ref) },
      currency: String(invoice.currency),
      dates: { issueDate: String(invoice.payment_completed_at).slice(0, 10),
        sellDate: String(invoice.payment_completed_at).slice(0, 10),
        handedOverAt: invoice.package_shipped_at as string | null, paymentCompletedAt: invoice.payment_completed_at as string },
      buyer: { name: buyer.name, email: buyer.email, taxIdentifier: null, companyName: null, address: null },
      payment: { intentRef: String(paidIntent.id), providerRef: String(invoice.provider_kind),
        providerPaymentRef: String(invoice.provider_payment_id), amountMinor: Number(paidIntent.amount_cents),
        currency: String(invoice.currency), localSettlementState: "matched" },
      orderMoney: { subtotalMinor: order.subtotal_cents, discountMinor: order.discount_cents,
        shippingMinor: order.shipping_cents, shippingDiscountMinor: order.shipping_discount_cents,
        totalMinor: order.total_cents as number },
      lines, totalGrossMinor: gross, totalNetMinor: net, totalTaxMinor: gross - net,
      chargedTotalGrossMinor: order.total_cents as number,
    };
    projected.invoicing_duties!.push({ id: work.id, order_id: invoice.order_id, parent_duty_id: null,
      document_id: null, request_id: null, original_key: targetTransitionKey(paidTransition.id), status: "owed",
      provider: invoice.provider_kind, seller_policy_version: "invoicing.seller.v1", generation: 0,
      claim_token: null, lease_until: null, available_at: work.created_at, fact_attempts: 0,
      fact_token: null, fact_lease_until: null, preflight_generation: null, reversal: null,
      last_result: null, created_at: invoice.created_at });
    projected.invoicing_fact_revisions!.push({ duty_id: work.id,
      revision_ref: facts.factRevision, facts, installed_at: invoice.created_at });
    const occurredAt = (await input.targetOwner.query<{ value: string }>(`SELECT pg_catalog.to_char($1::timestamptz AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value`, [paidTransition.occurred_at])).rows[0]?.value;
    if (!occurredAt) fail("invalid_input", "public.commerce_payment_state_transitions");
    const receipt = { sourceKind: "paid", sourceId: paidTransition.id, orderId: invoice.order_id,
      evidence: { settlementIntentId: paidIntent.id, amountMinor: paidIntent.amount_cents, currency: paidIntent.currency },
      occurredAt };
    for (const receiptKey of [`source:paid:${paidTransition.id}`,
      `key:paid:${paidIntent.id}:${targetTransitionKey(paidTransition.id)}`]) {
      projected.invoicing_effect_receipts!.push({ receipt_key: receiptKey, duty_id: work.id,
        payload: receipt, recorded_at: work.created_at });
    }
  }
  if (invoices.some(row => !issueOutbox.some(work => work.invoice_id === row.id)))
    fail("unsupported_table", "public.accounting_invoices");
  for (const [table, rows] of Object.entries(projected)) await replaceTargetRows(packet, table, rows, input.targetOwner);
  const mappedRelations = new Set(["public.clients", "public.admin_users", "auth.users", "public.admin_audit_events",
    "public.customer_subject_lifecycle_events", "public.identity_privacy_erasures", "public.commerce_orders",
    "public.commerce_order_items", "public.commerce_payments", "public.commerce_payment_intents",
    "public.commerce_payment_attempts", "public.commerce_payment_state_transitions", "public.outbox_events",
    "public.catalog_products", "public.catalog_skus", "public.price_lists", "public.price_entries",
    "public.subscriptions", "public.subscription_lines", "public.subscription_cycles", "public.subscription_events",
    "public.subscription_price_agreements", "public.commerce_payment_method_refs", "public.subscription_events",
    "public.communication_permissions", "public.accounting_invoice_issue_outbox"]);
  for (const entry of input.capture.dispositions) if (entry.rows && active.has(entry.relation) && !mappedRelations.has(entry.relation))
    fail("unsupported_table", entry.relation);
  const supportedHistory = new Set(["public.admin_audit_events", "public.payment_provider_settlement_batches",
    "public.payment_provider_settlement_items", "public.accounting_invoices", "public.commerce_idempotency_keys",
    "public.communication_contacts", "public.communication_contact_links", "public.communication_email_deliveries"]);
  for (const entry of input.capture.dispositions) if (entry.rows && history.has(entry.relation)
    && !active.has(entry.relation) && !supportedHistory.has(entry.relation)) fail("unsupported_table", entry.relation);
  if (values("payment_provider_settlement_batches").some(row => row.status !== "reconciled")
    || values("payment_provider_settlement_items").some(row => row.status !== "matched")
    || values("commerce_idempotency_keys").some(row => row.status !== "completed"))
    fail("unsupported_table", "public.payment_provider_settlement_batches");
  const settlementBatches = values("payment_provider_settlement_batches");
  const settlementItems = values("payment_provider_settlement_items");
  for (const batch of settlementBatches) {
    const entries = settlementItems.filter(item => item.batch_id === batch.id);
    if (!entries.length || entries.some(item => item.provider_kind !== batch.provider_kind
      || item.currency !== batch.currency || typeof item.net_cents !== "number" || typeof item.fee_cents !== "number"
      || item.gross_cents !== item.net_cents + item.fee_cents
      || !intents.some(intent => intent.id === item.payment_intent_id && intent.status === "succeeded"
        && intent.payment_id === item.payment_id && intent.provider_payment_id === item.provider_payment_id
        && intent.amount_cents === item.gross_cents))
      || entries.reduce((sum, item) => sum + Number(item.gross_cents), 0) !== batch.gross_cents
      || entries.reduce((sum, item) => sum + Number(item.fee_cents), 0) !== batch.fee_cents
      || entries.reduce((sum, item) => sum + Number(item.net_cents), 0) !== batch.net_cents)
      fail("target_conflict", "public.payment_provider_settlement_batches");
  }
  if (settlementItems.some(item => !settlementBatches.some(batch => batch.id === item.batch_id)))
    fail("target_conflict", "public.payment_provider_settlement_items");
  const { sha256: _inner, ...inner } = packet.compatible;
  packet.compatible.sha256 = digest(JSON.stringify(inner));
  const { sha256: _outer, ...outer } = packet;
  packet.sha256 = digest(JSON.stringify(outer));
  const mappingRequired = new Set(["auth.users", ...active]);
  const mappedToCanonical = new Set(["auth.users", "public.clients", "public.admin_users", "public.commerce_orders",
    "public.commerce_order_items", "public.commerce_payments", "public.commerce_payment_intents",
    "public.commerce_payment_state_transitions", "public.identity_privacy_erasures", "public.customer_subject_lifecycle_events",
    "public.catalog_products", "public.catalog_skus", "public.price_lists", "public.price_entries",
    "public.subscriptions", "public.subscription_lines", "public.subscription_cycles", "public.subscription_events",
    "public.subscription_price_agreements", "public.commerce_payment_method_refs", "public.communication_permissions",
    "public.accounting_invoice_issue_outbox"]);
  const historyOnly = new Set(["public.commerce_payment_attempts", "public.outbox_events"]);
  const dispositions = input.capture.dispositions.map(entry => {
    if (!entry.rows || !mappingRequired.has(entry.relation)) return entry;
    if (mappedToCanonical.has(entry.relation)) return { ...entry, disposition: "mapped-active-and-retained" as const,
      reason: "canonical target state and full private source row" };
    if (historyOnly.has(entry.relation)) return { ...entry, disposition: "retained-history" as const,
      reason: "terminal source effect; source key excluded from target active lookup" };
    fail("unsupported_table", entry.relation);
  });
  const targets: Record<string, string[]> = {
    "auth.users": ["clients", "platform_human_principals"],
    "public.clients": ["clients"], "public.admin_users": ["platform_human_principals", "platform_human_memberships"],
    "public.catalog_products": ["catalog_products"], "public.catalog_skus": ["catalog_skus"],
    "public.price_lists": ["price_lists"], "public.price_entries": ["price_entries"],
    "public.subscriptions": ["subscriptions", "subscription_renewal_terms"],
    "public.subscription_events": ["subscription_events"],
    "public.subscription_lines": ["subscription_lines", "subscription_renewal_term_lines"],
    "public.subscription_cycles": ["subscription_cycles"],
    "public.subscription_price_agreements": ["subscription_lines", "subscription_renewal_term_lines"],
    "public.commerce_payment_method_refs": ["subscription_renewal_terms"],
    "public.commerce_orders": ["commerce_orders"], "public.commerce_order_items": ["commerce_order_items"],
    "public.commerce_payments": ["commerce_settlement_intents"],
    "public.commerce_payment_intents": ["commerce_settlement_intents"],
    "public.commerce_payment_state_transitions": ["commerce_settlement_transitions"],
    "public.communication_permissions": ["communication_recipient_consents"],
    "public.accounting_invoice_issue_outbox": ["invoicing_duties"],
    "public.accounting_invoices": ["invoicing_fact_revisions"],
    "public.customer_subject_lifecycle_events": ["customer_subject_lifecycle_events"],
    "public.identity_privacy_erasures": ["identity_privacy_erasures"],
  };
  const principalAliases = new Map(mapped.subjects.map(subject => [subject.managedId, subject.principalId]));
  const rows = input.capture.rows.map(row => {
    const value = JSON.parse(row.value) as Row;
    const targetTables = row.relation === "public.outbox_events" ? value.status === "pending" ? ["outbox_events"] : []
      : row.relation === "public.admin_audit_events" ? value.action === "revoke" ? ["platform_human_membership_audit_events"] : []
        : row.relation === "public.subscription_price_agreements" && value.ended_at !== null ? []
          : row.relation === "public.commerce_payment_method_refs" && (value.status !== "active" || value.active !== true) ? []
            : targets[row.relation] ?? [];
    const terminalSourceRow = historyOnly.has(row.relation)
      || row.relation === "public.subscription_price_agreements" && value.ended_at !== null
      || row.relation === "public.commerce_payment_method_refs" && (value.status !== "active" || value.active !== true);
    if (row.disposition === "requires-active-mapping" && !targetTables.length && !terminalSourceRow)
      fail("unsupported_table", row.relation);
    const subjects = [...new Set([...row.subjects,
      ...row.subjects.flatMap(subject => principalAliases.has(subject) ? [principalAliases.get(subject)!] : [])])].sort();
    return { ...row, subjects,
      disposition: targetTables.length ? "mapped-active-and-retained" as const : "retained-history" as const,
      targetTables, reason: targetTables.length ? "canonical target projection and full private source row"
        : "terminal source receipt or full private business history" };
  });
  const { sha256: _retained, ...retainedBody } = input.capture;
  const body = { ...retainedBody, dispositions, rows };
  return { packet, retained: { ...body, sha256: digest(JSON.stringify(body)) } };
}

async function replaceTargetRows(packet: ConnectedNativeStoreCapture, table: string, rows: Row[], owner: Pool): Promise<void> {
  const held = packet.compatible.tables.find(value => value.table === table)
    ?? packet.owned.find(value => value.table === table);
  if (!held || held.rows.length) fail("target_conflict", table);
  const columns = held.columns.map(column => column.name);
  const normalized: string[] = [];
  for (const row of rows) {
    if (Object.keys(row).sort().join("\0") !== [...columns].sort().join("\0")) fail("schema_conflict", table);
    try {
      const result = await owner.query<{ value: string }>(`SELECT pg_catalog.to_jsonb(p)::pg_catalog.text AS value
        FROM pg_catalog.jsonb_populate_record(NULL::public.${quoted(table)},$1::jsonb) p`, [JSON.stringify(row)]);
      if (result.rows.length !== 1) fail("invalid_input", table);
      normalized.push(result.rows[0]!.value);
    } catch (error) {
      if (typeof (error as { code?: unknown })?.code === "string" && /^2[23]/.test((error as { code: string }).code)) fail("invalid_input", table);
      throw error;
    }
  }
  held.rows = normalized.sort();
}

/** A private object descriptor; readback verifies the exact retained bytes. */
export function exportManagedRetainedHistory(capture: ManagedRetainedCapture): {
  key: string; bytes: Uint8Array; sha256: string; object: TransferObject;
} {
  validate(capture);
  if (capture.rows.some(row => row.disposition === "requires-active-mapping")) fail("invalid_input");
  const bytes = Buffer.from(JSON.stringify(capture));
  if (bytes.byteLength > 64 * 1024 * 1024) fail("limit_exceeded");
  const key = `retained-history/${digest(capture.sourceId)}/${capture.sha256}.json`, sha256 = digest(bytes);
  return { key, bytes, sha256, object: { key, version: capture.sha256, bytes: bytes.byteLength, sha256,
    metadata: { contentType: "application/json", purpose: "managed-retained-history" }, access: "private-retained-history",
    lineage: { sourceId: capture.sourceId, snapshotId: capture.observation.snapshot, sourceVersion: capture.sha256 } } };
}
/** Bind the private history object to the exact canonical row packet before publication. */
export function assembleManagedRetainedTransfer(input: {
  packet: ConnectedNativeStoreCapture; retained: ManagedRetainedCapture;
}): ManagedRetainedTransfer {
  const retainedObject = exportManagedRetainedHistory(input.retained);
  if (input.packet.compatible.sourceId !== input.retained.sourceId
    || JSON.stringify(input.packet.observation) !== JSON.stringify(input.retained.observation)) fail("target_conflict");
  const body = { format: "openlup.managed-retained-transfer.v1" as const,
    sourceId: input.retained.sourceId, packetSha256: input.packet.sha256,
    retainedKey: retainedObject.key, retainedSha256: retainedObject.sha256,
    retainedDescriptorSha256: descriptorDigest(retainedObject.object) };
  return { packet: input.packet, retainedObject, manifest: { ...body, sha256: digest(JSON.stringify(body)) } };
}
/** The managed admission route requires exact retained-object readback before DB mutation. */
export async function restoreManagedRetainedTransfer(input: Omit<Parameters<typeof restoreConnectedNativeStore>[0], "packet"> & {
  transfer: ManagedRetainedTransfer;
  retainedObjects: TransferObjectReader;
}): ReturnType<typeof restoreConnectedNativeStore> {
  const { transfer } = input;
  if (!transfer?.manifest || !transfer.retainedObject || !transfer.packet
    || transfer.manifest.format !== "openlup.managed-retained-transfer.v1") fail("invalid_input");
  const { sha256, ...body } = transfer.manifest;
  if (digest(JSON.stringify(body)) !== sha256 || body.packetSha256 !== transfer.packet.sha256
    || body.retainedKey !== transfer.retainedObject.key || body.retainedSha256 !== transfer.retainedObject.sha256
    || body.retainedDescriptorSha256 !== descriptorDigest(transfer.retainedObject.object)
    || transfer.retainedObject.object.key !== transfer.retainedObject.key
    || transfer.retainedObject.object.sha256 !== transfer.retainedObject.sha256
    || transfer.retainedObject.object.bytes !== transfer.retainedObject.bytes.byteLength
    || transfer.retainedObject.object.access !== "private-retained-history")
    fail("invalid_input");
  if (!input.retainedObjects || typeof input.retainedObjects.read !== "function") fail("invalid_input");
  const stored = await input.retainedObjects.read(body.retainedKey, transfer.retainedObject.object.version);
  if (!isDeepStrictEqual(stored.object, transfer.retainedObject.object)) fail("invalid_input");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stored.body) {
    if (!(chunk instanceof Uint8Array)) fail("invalid_input");
    length += chunk.byteLength;
    if (length > transfer.retainedObject.object.bytes || length > 64 * 1024 * 1024) fail("limit_exceeded");
    chunks.push(Buffer.from(chunk));
  }
  if (length !== transfer.retainedObject.object.bytes) fail("invalid_input");
  const retained = readManagedRetainedHistory(Buffer.concat(chunks, length), transfer.retainedObject.sha256);
  if (retained.sourceId !== body.sourceId || retained.sourceId !== transfer.packet.compatible.sourceId
    || body.retainedKey !== `retained-history/${digest(retained.sourceId)}/${retained.sha256}.json`
    || transfer.retainedObject.object.version !== retained.sha256
    || transfer.retainedObject.object.lineage?.sourceId !== retained.sourceId
    || transfer.retainedObject.object.lineage.snapshotId !== retained.observation.snapshot
    || JSON.stringify(retained.observation) !== JSON.stringify(transfer.packet.observation)
    || retained.rows.some(row => row.disposition === "requires-active-mapping")) fail("invalid_input");
  return restoreConnectedNativeStore({ owner: input.owner, installation: input.installation,
    packet: transfer.packet, freshTarget: input.freshTarget });
}
export function readManagedRetainedHistory(bytes: Uint8Array, expectedSha256: string): ManagedRetainedCapture {
  if (digest(bytes) !== expectedSha256) fail("invalid_input");
  let value: ManagedRetainedCapture;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")) as ManagedRetainedCapture; }
  catch { fail("invalid_input"); }
  validate(value);
  return value;
}
export function redactManagedRetainedHistory(capture: ManagedRetainedCapture, subject: string): ManagedRetainedCapture {
  validate(capture);
  if (!subject) fail("invalid_input");
  const { sha256: _old, ...body } = capture;
  const removed = body.rows.filter(row => row.subjects.includes(subject));
  const changed = { ...body, rows: body.rows.filter(row => !row.subjects.includes(subject)),
    redactions: [...body.redactions, { subjectDigest: digest(subject), rows: removed.map(row => ({ relation: row.relation,
      rowDigest: digest(JSON.stringify([row.source,row.relation,row.rowIdentity])) })).sort((left,right) => left.rowDigest.localeCompare(right.rowDigest)) }] };
  return { ...changed, sha256: digest(JSON.stringify(changed)) };
}
function validate(capture: ManagedRetainedCapture): void {
  try {
    if (capture?.format !== "openlup.managed-retained-history.v1" || !Array.isArray(capture.rows)
      || !Array.isArray(capture.dispositions) || !Array.isArray(capture.redactions)) fail("invalid_input");
    const { sha256, ...body } = capture;
    if (digest(JSON.stringify(body)) !== sha256) fail("invalid_input");
    if (capture.rows.some(row => row.source !== capture.sourceId || !row.relation || !row.rowIdentity
      || !Array.isArray(row.subjects) || !row.subjects.every(value => typeof value === "string" && value)
      || typeof row.value !== "string" || !["requires-active-mapping", "mapped-active-and-retained", "retained-history"].includes(row.disposition)
      || !Array.isArray(row.targetTables) || row.targetTables.some(value => typeof value !== "string" || !identity.test(value))
      || (row.disposition === "mapped-active-and-retained") !== (row.targetTables.length > 0)
      || typeof row.reason !== "string" || !row.reason || (!row.subjects.length && ![
        "storage.buckets", "public.catalog_products", "public.catalog_skus", "public.price_lists", "public.price_entries",
      ].includes(row.relation)))) fail("invalid_input");
    if (capture.redactions.some(entry => !/^[0-9a-f]{64}$/.test(entry.subjectDigest)
      || !Array.isArray(entry.rows) || entry.rows.some(value => !value.relation || !/^[0-9a-f]{64}$/.test(value.rowDigest)))) fail("invalid_input");
    const present = capture.rows.map(row => `${row.relation}\0${row.rowIdentity}`);
    if (new Set(present).size !== present.length) fail("target_conflict");
    const disposition = new Map(capture.dispositions.map(entry => [entry.relation, entry]));
    if (disposition.size !== capture.dispositions.length || capture.rows.some(row => !disposition.has(row.relation))) fail("invalid_input");
    if (capture.dispositions.some(entry => !Number.isSafeInteger(entry.rows) || entry.rows < 0 || ![
      "requires-active-mapping", "mapped-active-and-retained", "retained-history", "unsupported-empty",
      "credential-excluded", "service-installation-history",
    ].includes(entry.disposition))) fail("invalid_input");
    const redacted = capture.redactions.flatMap(entry => entry.rows);
    if (new Set(redacted.map(row => row.rowDigest)).size !== redacted.length) fail("target_conflict");
    for (const entry of capture.dispositions) {
      const retained = capture.rows.filter(row => row.relation === entry.relation).length;
      const removed = redacted.filter(row => row.relation === entry.relation).length;
      if (entry.disposition === "credential-excluded" || entry.disposition === "service-installation-history") {
        if (retained || removed) fail("invalid_input");
      } else if (retained + removed !== entry.rows) fail("invalid_input");
    }
  } catch (error) { if (error instanceof PostgresTransferError) throw error; fail("invalid_input"); }
}
