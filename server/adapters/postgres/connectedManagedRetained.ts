import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { PostgresTransferError, type CompatiblePostgresSnapshot } from "@openlup/platform/portability";
import { mapManagedIdentityForConnectedRestore, type ManagedIdentityMappingResult, type ManagedIdentityMappingSource } from "./connectedStoreRestore.js";
import { connectedStoreClusterIdentitySql, type ConnectedNativeStoreCapture } from "./connectedStoreCapture.js";

type Row = Record<string, unknown>;
type Disposition = "requires-active-mapping" | "retained-history" | "unsupported-empty" |
  "credential-excluded" | "service-installation-history";
export interface ManagedSourceCapture {
  sourceId: string;
  observation: { cluster: string; database: string; login: string; snapshot: string };
  dispositions: { relation: string; rows: number; disposition: Disposition; reason: string }[];
  sha256: string;
}

// The positive managed profile is finite. A nonempty relation outside this
// inventory refuses; a source schema change never silently becomes an archive.
const active = new Set([
  "public.clients", "public.admin_users", "public.subscriptions", "public.subscription_cycles",
  "public.subscription_events", "public.subscription_lines", "public.commerce_orders", "public.commerce_order_items",
  "public.commerce_payments", "public.commerce_payment_intents", "public.commerce_payment_attempts",
  "public.outbox_events", "public.commerce_payment_state_transitions", "public.communication_permissions",
  "public.subscription_price_agreements", "public.commerce_payment_method_refs",
  "public.identity_privacy_erasures", "public.customer_subject_lifecycle_events",
  "public.catalog_products", "public.catalog_skus", "public.price_lists", "public.price_entries",
]);
const history = new Set([
  "public.admin_audit_events", "public.customer_subject_lifecycle_events", "public.commerce_payment_reconciliation_runs",
  "public.payment_provider_settlement_batches", "public.payment_provider_settlement_items",
  "public.accounting_invoice_operations", "public.accounting_invoice_issue_outbox", "public.accounting_invoice_correction_outbox",
  "public.accounting_invoice_delivery_outbox", "public.communication_delivery_events",
  "public.communication_provider_events", "public.communication_email_deliveries",
  "public.subscription_dunning_cases", "public.subscription_dunning_notifications",
  "public.commerce_payment_state_transitions", "public.payment_external_refs",
  "public.commerce_payment_attempts", "public.subscription_price_agreements",
  "public.accounting_invoices", "public.commerce_idempotency_keys",
  "public.communication_contacts", "public.communication_contact_links", "public.communication_permission_events",
]);
// The pinned baseline does not hold these two; the identity mapping reads them when a source does.
const absentFromBaseline = new Set(["public.identity_privacy_erasures", "public.customer_subject_lifecycle_events"]);
const installation = new Set(["auth.schema_migrations", "storage.migrations", "public.schema_migrations",
  "_realtime.extensions", "_realtime.schema_migrations", "_realtime.tenants", "realtime.schema_migrations",
  "supabase_functions.migrations", "supabase_migrations.schema_migrations"]);
const credentials = new Set([
  "auth.sessions", "auth.refresh_tokens", "auth.flow_state", "auth.one_time_tokens", "auth.identities",
  "auth.mfa_factors", "auth.mfa_challenges", "auth.audit_log_entries",
]);
const metadata = new Set(["auth.users", "storage.buckets", "storage.objects"]);
// Managed Storage has no typed object path in this parcel. The other finite
// source classes below use their existing state checks and disposition values.
const uncarried = new Set(["storage.buckets", "storage.objects"]);
const attemptLinks = (intent: Row, payment: Row, attempt: Row | undefined, transition: Row | undefined): boolean =>
  !!attempt && !!transition && attempt.payment_intent_id === intent.id && attempt.payment_id === payment.id
  && attempt.amount_cents === intent.amount_cents && attempt.currency === intent.currency
  && payment.amount_cents === intent.amount_cents && payment.currency === intent.currency
  && attempt.provider === payment.provider
  && (payment.provider_payment_id === null || intent.provider_payment_id === null
    || payment.provider_payment_id === intent.provider_payment_id)
  && (intent.active_attempt_id === null || intent.active_attempt_id === attempt.id)
  && (transition.payment_attempt_id === null || transition.payment_attempt_id === attempt.id);
const checkedTerminalUnpaid = (intent: Row | undefined, all: Map<string, Row[]>): boolean => {
  if (!intent || !["failed", "cancelled", "expired"].includes(String(intent.status))) return false;
  const payment = all.get("public.commerce_payments")?.find(row => row.id === intent.payment_id);
  const linkedIntents = all.get("public.commerce_payment_intents")?.filter(row => row.payment_id === intent.payment_id) ?? [];
  const order = all.get("public.commerce_orders")?.find(row => row.id === intent.order_id);
  const attempts = all.get("public.commerce_payment_attempts")?.filter(row => row.payment_intent_id === intent.id) ?? [];
  const transitions = all.get("public.commerce_payment_state_transitions")?.filter(row => row.payment_intent_id === intent.id) ?? [];
  const items = all.get("public.payment_provider_settlement_items") ?? [];
  return !!payment && !!order && linkedIntents.length === 1
    && payment.order_id === intent.order_id && payment.status === intent.status
    && intent.target_kind === "one_time_order" && intent.subscription_id === null && intent.subscription_cycle_id === null
    && intent.amount_cents === order.total_cents && intent.currency === order.currency
    && order.status === "pending_payment" && intent.active_attempt_id === null
    && attempts.length === 1 && attempts[0]?.status === intent.status
    && transitions.length === 1 && transitions[0]?.to_status === intent.status
    && attemptLinks(intent, payment, attempts[0], transitions[0])
    && !items.some(item => item.payment_intent_id === intent.id || item.payment_id === payment.id);
};
const archiveState = (relation: string, row: Row, captureTimeMs: number, all: Map<string, Row[]>): boolean => {
  if (relation === "public.payment_provider_settlement_batches") return row.status === "reconciled";
  if (relation === "public.payment_provider_settlement_items") return row.status === "matched";
  if (relation === "public.commerce_idempotency_keys") {
    const expiry = typeof row.expires_at === "string" ? Date.parse(row.expires_at) : Number.NaN;
    return row.status === "completed" && Number.isFinite(expiry) && expiry <= captureTimeMs;
  }
  if (["public.commerce_payments", "public.commerce_payment_intents", "public.commerce_payment_attempts",
    "public.commerce_payment_state_transitions"].includes(relation)) {
    const intent = relation === "public.commerce_payment_intents" ? row
      : all.get("public.commerce_payment_intents")?.find(value => value.id === row.payment_intent_id
        || relation === "public.commerce_payments" && value.payment_id === row.id);
    return intent?.status !== "failed" && checkedTerminalUnpaid(intent, all);
  }
  if (relation === "public.payment_external_refs") {
    const payment = all.get("public.commerce_payments")?.find(value => value.id === row.payment_id);
    const intents = all.get("public.commerce_payment_intents")?.filter(value => value.payment_id === row.payment_id) ?? [];
    const refs = all.get(relation)?.filter(value => value.payment_id === row.payment_id) ?? [];
    if (!payment || intents.length !== 1 || refs.length !== 1 || row.provider_kind !== payment.provider
      || payment.provider_payment_id !== null && payment.provider_payment_id !== row.provider_payment_id
      || intents[0]!.provider_payment_id !== null && intents[0]!.provider_payment_id !== row.provider_payment_id) return false;
    const intent = intents[0]!;
    return intent.status === "succeeded" && payment.status === "succeeded"
        && intent.provider_payment_id === row.provider_payment_id
      || checkedTerminalUnpaid(intent, all);
  }
  return false;
};
const stateClass = new Set(["public.payment_provider_settlement_batches",
  "public.payment_provider_settlement_items", "public.commerce_idempotency_keys", "public.payment_external_refs",
  "public.commerce_payments", "public.commerce_payment_intents", "public.commerce_payment_attempts",
  "public.commerce_payment_state_transitions"]);
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
// Source rows are used for the immediate typed projection only. Neither the
// capture result nor the connected restore packet contains a source-row archive.
const projectionRows = new WeakMap<ManagedSourceCapture, Map<string, Row[]>>();
function fail(code: ConstructorParameters<typeof PostgresTransferError>[0], relation?: string): never {
  throw new PostgresTransferError(code, relation);
}
const quoted = (value: string): string => value.length <= 63 && !value.includes("\0")
  ? `"${value.replaceAll('"', '""')}"` : fail("invalid_input");
// The exact decimal a JSON number's text denotes, so a rounded number cannot compare equal.
const decimal = (text: string): string => {
  const [mantissa = "", exponent = "0"] = text.toLowerCase().split("e");
  const [whole = "", fraction = ""] = mantissa.replace("-", "").split(".");
  const digits = (whole + fraction).replace(/^0+/, ""), kept = digits.replace(/0+$/, "");
  if (!kept) return "0";
  return `${text.startsWith("-") ? "-" : ""}${kept}e${Number(exponent) - fraction.length + digits.length - kept.length}`;
};
// A number a double cannot hold would reach the target rounded, and restore's census sees only the rounded value.
const exactNumbers = (relation: string) => (_key: string, value: unknown, context?: { source?: string }): unknown => {
  if (typeof value === "number" && (!context?.source || decimal(context.source) !== decimal(String(value))))
    fail("invalid_input", relation);
  return value;
};

/** Inspect one managed snapshot and retain only a relation census outside the
 * projection call. Full source history remains in the operator's source archive.
 * Auth credentials are never selected.
 */
export async function captureManagedSourceGraph(input: {
  source: CompatiblePostgresSnapshot;
  sourceId: string;
  maximumRows: number;
  maximumBytes: number;
}): Promise<ManagedSourceCapture> {
  if (typeof input.sourceId !== "string" || !input.sourceId || input.sourceId.length > 1024
    || !Number.isSafeInteger(input.maximumRows) || input.maximumRows < 1 || input.maximumRows > 10000
    || !Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1 || input.maximumBytes > 64 * 1024 * 1024) fail("invalid_input");
  try {
    return await input.source.withSnapshot(async db => {
      const facts = (await db.query<{ readonly: string; isolation: string; cluster: string; database: string; login: string; snapshot: string; capture_time_ms: string }>(
        `SELECT pg_catalog.current_setting('transaction_read_only') AS readonly,
          pg_catalog.current_setting('transaction_isolation') AS isolation,
          ${connectedStoreClusterIdentitySql} AS cluster,
          pg_catalog.current_database() AS database,session_user::pg_catalog.text AS login,
          pg_catalog.txid_current_snapshot()::pg_catalog.text AS snapshot,
          pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.transaction_timestamp()) * 1000)::bigint::text AS capture_time_ms`)).rows[0];
      if (facts?.readonly !== "on" || facts.isolation !== "repeatable read") fail("invalid_input");
      const captureTimeMs = Number(facts.capture_time_ms);
      if (!Number.isSafeInteger(captureTimeMs)) fail("invalid_input");
      await db.query("SET LOCAL TimeZone = 'UTC'");
      // A login that row security would filter must fail here, not read an empty source.
      await db.query("SET LOCAL row_security = off");
      const relations = (await db.query<{ schema: string; table: string }>(`SELECT n.nspname AS schema,c.relname AS table
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE pg_catalog.left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
          AND c.relkind IN ('r','p')
        ORDER BY n.nspname,c.relname`)).rows;
      const sourceRows = new Map<string, Row[]>();
      const dispositions: ManagedSourceCapture["dispositions"] = [];
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
        // relations are inventoried, then refused if their state has no typed path.
        const expression = name === "auth.users"
          ? "pg_catalog.jsonb_build_object('id',t.id,'email',t.email,'created_at',t.created_at,'updated_at',t.updated_at)"
          : "pg_catalog.to_jsonb(t)";
        const keyColumns = (await db.query<{ name: string }>(`SELECT a.attname AS name
          FROM pg_catalog.pg_index i
          CROSS JOIN LATERAL pg_catalog.unnest(i.indkey) WITH ORDINALITY k(attnum,ordinal)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
          WHERE i.indrelid=$1::pg_catalog.regclass AND i.indisprimary ORDER BY k.ordinal`, [qualified])).rows;
        if (!keyColumns.length) fail("schema_conflict", name);
        const raw = (await db.query<{ value: string }>(`SELECT (${expression})::pg_catalog.text AS value
          FROM ${qualified} t ORDER BY (${expression})::pg_catalog.text LIMIT $1`,
        [input.maximumRows + 1])).rows;
        totalRows += raw.length; totalBytes += raw.reduce((sum, row) => sum + Buffer.byteLength(row.value), 0);
        if (totalRows > input.maximumRows || totalBytes > input.maximumBytes) fail("limit_exceeded", name);
        const parsed = raw.map(row => (active.has(name) ? JSON.parse(row.value, exactNumbers(name)) : JSON.parse(row.value)) as Row);
        sourceRows.set(name, parsed);
        const required = active.has(name) || name === "auth.users" || raw.length > 0 && uncarried.has(name);
        dispositions.push({ relation: name, rows: raw.length, disposition: required
          ? "requires-active-mapping" : "retained-history", reason: required ? "typed target projection required before publication"
          : "operator source archive; no transfer row" });
      }
      for (const entry of dispositions) if (stateClass.has(entry.relation)) {
        const rows = sourceRows.get(entry.relation) ?? [];
        const required = rows.some(row => !archiveState(entry.relation, row, captureTimeMs, sourceRows));
        entry.disposition = required ? "requires-active-mapping" : "retained-history";
        entry.reason = required ? "typed target projection required before publication" : "operator source archive; no transfer row";
      }
      // A missing carried relation would read as empty, and its obligations would vanish with no refusal.
      for (const name of active) if (!sourceRows.has(name) && !absentFromBaseline.has(name)) fail("schema_conflict", name);
      const owners = subjectOwners(sourceRows);
      for (const [relation, rows] of sourceRows)
        for (const row of rows) if (owners(relation, row) === null) fail("invalid_input", relation);
      const body = { sourceId: input.sourceId,
        observation: { cluster: facts.cluster, database: facts.database, login: facts.login, snapshot: facts.snapshot },
        dispositions };
      const capture = { ...body, sha256: digest(JSON.stringify(body)) };
      projectionRows.set(capture, sourceRows);
      return capture;
    });
  } catch (error) { if (error instanceof PostgresTransferError) throw error; fail("database_unavailable"); }
}

// Preserve the source graph's populated-link and cross-owner conflict checks.
// Resolved owners are validation facts only; no subject tags are serialized.
function subjectOwners(all: Map<string, Row[]>): (relation: string, row: Row) => string[] | null {
  const clients = new Map(all.get("public.clients")?.map(row => [row.id, row]) ?? []);
  const authUsers = new Map(all.get("auth.users")?.map(row => [row.id, row]) ?? []);
  const adminUsers = new Map(all.get("public.admin_users")?.map(row => [row.id, row]) ?? []);
  const subscriptions = new Map(all.get("public.subscriptions")?.map(row => [row.id, row]) ?? []);
  const cycles = new Map(all.get("public.subscription_cycles")?.map(row => [row.id, row]) ?? []);
  const lines = new Map(all.get("public.subscription_lines")?.map(row => [row.id, row]) ?? []);
  const subscriptionEvents = new Map(all.get("public.subscription_events")?.map(row => [row.id, row]) ?? []);
  const orders = new Map(all.get("public.commerce_orders")?.map(row => [row.id, row]) ?? []);
  const intents = new Map(all.get("public.commerce_payment_intents")?.map(row => [row.id, row]) ?? []);
  const payments = new Map(all.get("public.commerce_payments")?.map(row => [row.id, row]) ?? []);
  const attempts = new Map(all.get("public.commerce_payment_attempts")?.map(row => [row.id, row]) ?? []);
  const invoices = new Map(all.get("public.accounting_invoices")?.map(row => [row.id, row]) ?? []);
  const outbox = new Map(all.get("public.outbox_events")?.map(row => [row.id, row]) ?? []);
  const contacts = new Map(all.get("public.communication_contacts")?.map(row => [row.id, row]) ?? []);
  const erasedPrincipals = new Set<string>();
  const erasedPrincipalByClient = new Map<string, string>();
  for (const row of all.get("public.identity_privacy_erasures") ?? []) {
    if (typeof row.principal_id !== "string" || typeof row.completed_at !== "string") continue;
    erasedPrincipals.add(row.principal_id);
    if (typeof row.client_id !== "string") continue;
    const prior = erasedPrincipalByClient.get(row.client_id);
    if (prior && prior !== row.principal_id) fail("target_conflict", "public.identity_privacy_erasures");
    erasedPrincipalByClient.set(row.client_id, row.principal_id);
  }
  const contactOwners = new Map<unknown, string[]>();
  for (const row of clients.values()) if (typeof row.marketing_contact_id === "string" && typeof row.id === "string")
    contactOwners.set(row.marketing_contact_id, [...new Set([...(contactOwners.get(row.marketing_contact_id) ?? []), row.id])]);
  for (const row of all.get("public.communication_contact_links") ?? []) {
    if (row.source_table !== "clients" || typeof row.source_id !== "string") continue;
    contactOwners.set(row.contact_id, [...new Set([...(contactOwners.get(row.contact_id) ?? []), row.source_id])]);
  }
  const byClient = (id: unknown): string[] | null => {
    if (typeof id !== "string") return null;
    const client = clients.get(id);
    if (!client) return null;
    const erased = erasedPrincipalByClient.get(id);
    if (client.auth_user_id === null) return erased ? [id, erased] : [id];
    if (typeof client.auth_user_id !== "string"
      || !authUsers.has(client.auth_user_id) && !erasedPrincipals.has(client.auth_user_id)
      || erased && erased !== client.auth_user_id) return null;
    return [id, client.auth_user_id];
  };
  const byAuth = (id: unknown): string[] | null => typeof id === "string"
    && (authUsers.has(id) || erasedPrincipals.has(id)) ? [id] : null;
  const byAdmin = (id: unknown): string[] | null => typeof id === "string" && adminUsers.has(id) ? [id] : null;
  const bySubscription = (id: unknown): string[] | null => byClient(subscriptions.get(id)?.client_id);
  const byCycle = (id: unknown): string[] | null => bySubscription(cycles.get(id)?.subscription_id);
  const byLine = (id: unknown): string[] | null => bySubscription(lines.get(id)?.subscription_id);
  const bySubscriptionEvent = (id: unknown): string[] | null => bySubscription(subscriptionEvents.get(id)?.subscription_id);
  const byOrder = (id: unknown): string[] | null => byClient(orders.get(id)?.client_id);
  const byIntent = (id: unknown): string[] | null => byOrder(intents.get(id)?.order_id);
  const byPayment = (id: unknown): string[] | null => byOrder(payments.get(id)?.order_id);
  const byAttempt = (id: unknown): string[] | null => byIntent(attempts.get(id)?.payment_intent_id);
  const byInvoice = (id: unknown): string[] | null => byOrder(invoices.get(id)?.order_id);
  const byContact = (id: unknown): string[] | null => {
    if (!contacts.has(id)) return null;
    const linked = contactOwners.get(id);
    if (!linked) return null;
    const owners = linked.map(byClient);
    return owners.some(owner => owner === null) ? null : [...new Set(owners.flatMap(owner => owner!))];
  };
  const byAggregate = (kind: unknown, id: unknown): string[] | null => kind === "subscription" ? bySubscription(id)
    : kind === "commerce_order" ? byOrder(id) : null;
  const byOutbox = (id: unknown): string[] | null => {
    const row = outbox.get(id);
    return row ? byAggregate(row.aggregate_type, row.aggregate_id) : null;
  };
  const unionLinks = (relation: string, links: [unknown, (id: unknown) => string[] | null][]): string[] | null => {
    const owners: string[] = [];
    for (const [id, resolve] of links) {
      if (id === null) continue;
      const found = resolve(id);
      if (!found?.length) fail("target_conflict", relation);
      owners.push(...found);
    }
    return owners.length ? [...new Set(owners)] : null;
  };
  const settlementItems = all.get("public.payment_provider_settlement_items") ?? [];
  const bySettlementItem = (row: Row): string[] | null => {
    const links = [[row.payment_intent_id, intents], [row.payment_id, payments], [row.invoice_id, invoices]] as const;
    const orders: string[] = [];
    for (const [id, rows] of links) {
      if (id === null) continue;
      const orderId = rows.get(id)?.order_id;
      if (typeof orderId !== "string") fail("target_conflict", "public.payment_provider_settlement_items");
      orders.push(orderId);
    }
    if (new Set(orders).size > 1) fail("target_conflict", "public.payment_provider_settlement_items");
    if (!orders.length) return null;
    return byOrder(orders[0]) ?? fail("target_conflict", "public.payment_provider_settlement_items");
  };
  return (relation, row) => {
    if (relation === "public.clients") return unionLinks(relation,
      [[row.id, byClient], [row.marketing_contact_id, byContact]]);
    if (relation === "auth.users") return typeof row.id === "string" ? [row.id] : null;
    if (relation === "public.admin_users") return unionLinks(relation,
      [[row.id, byAdmin], [row.membership_revoked_by, byAdmin]]);
    if (relation === "public.admin_audit_events") {
      return unionLinks(relation, [[row.actor_admin_id, byAdmin], [row.target_admin_id, byAdmin],
        [row.action === "customer_read" ? row.entity_id : null, byClient]]);
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
    if (relation === "public.subscription_cycles") return unionLinks(relation,
      [[row.subscription_id, bySubscription], [row.order_id, byOrder], [row.payment_id, byPayment]]);
    if (relation === "public.subscription_events") return unionLinks(relation,
      [[row.subscription_id, bySubscription], [row.cycle_id, byCycle]]);
    if (relation === "public.subscription_price_agreements") return unionLinks(relation,
      [[row.subscription_id, bySubscription], [row.subscription_line_id, byLine], [row.event_id, bySubscriptionEvent]]);
    if (relation.startsWith("public.subscription_")) return bySubscription(row.subscription_id);
    if (relation === "public.commerce_orders") return byOrder(row.id);
    if (relation === "public.commerce_order_items" || relation === "public.commerce_payments") return byOrder(row.order_id);
    if (relation === "public.commerce_payment_intents") return unionLinks(relation, [[row.order_id, byOrder],
      [row.subscription_id, bySubscription], [row.subscription_cycle_id, byCycle], [row.payment_id, byPayment],
      [row.active_attempt_id, byAttempt]]);
    if (relation === "public.commerce_payment_attempts") return unionLinks(relation,
      [[row.payment_intent_id, byIntent], [row.payment_id, byPayment]]);
    if (relation === "public.commerce_payment_state_transitions") return unionLinks(relation,
      [[row.payment_intent_id, byIntent], [row.payment_attempt_id, byAttempt]]);
    if (relation === "public.payment_external_refs") return byPayment(row.payment_id);
    if (relation === "public.commerce_payment_method_refs") return unionLinks(relation,
      [[row.client_id, byClient], [row.subscription_id, bySubscription]]);
    if (relation === "public.commerce_payment_reconciliation_runs") return byIntent(row.payment_intent_id);
    if (relation === "public.payment_provider_settlement_items") return bySettlementItem(row);
    if (relation === "public.payment_provider_settlement_batches") {
      const items = settlementItems.filter(item => item.batch_id === row.id);
      if (!items.length) return null;
      const owners = items.map(bySettlementItem);
      return owners.some(owner => owner === null) ? null : [...new Set(owners.flatMap(owner => owner!))];
    }
    if (relation === "public.commerce_idempotency_keys") return [];
    if (relation === "public.accounting_invoices") return byInvoice(row.id);
    if (relation.startsWith("public.accounting_invoice_")) return byInvoice(row.invoice_id);
    if (relation === "public.communication_contacts" || relation === "public.communication_permissions"
      || relation === "public.communication_permission_events")
      return byContact(relation === "public.communication_contacts" ? row.id : row.contact_id);
    if (relation === "public.communication_contact_links") {
      if (row.source_table !== "clients" || typeof row.source_id !== "string") fail("target_conflict", relation);
      return unionLinks(relation, [[row.contact_id, byContact], [row.source_id, byClient]]);
    }
    if (relation === "public.communication_provider_events") {
      if (row.contact_id !== null) return byContact(row.contact_id);
      return [];
    }
    if (relation === "public.communication_email_deliveries") return unionLinks(relation,
      [[row.client_id, byClient], [row.contact_id, byContact], [row.auth_user_id, byAuth],
        [row.outbox_event_id, byOutbox], [row.aggregate_id, id => byAggregate(row.aggregate_type, id)]]);
    if (relation === "public.catalog_products" || relation === "public.catalog_skus"
      || relation === "public.price_lists" || relation === "public.price_entries") return [];
    if (relation === "public.outbox_events") {
      return unionLinks(relation, [[row.aggregate_id, id => byAggregate(row.aggregate_type, id)]]);
    }
    if (relation === "storage.buckets") return [];
    if (relation === "storage.objects") return typeof row.owner_id === "string" && row.owner_id ? [row.owner_id] : null;
    return null;
  };
}

/** Read #428's finite identity input from the captured managed Auth/business rows. */
export function managedIdentityEvidence(capture: ManagedSourceCapture, issuer: string): ManagedIdentityMappingSource {
  validateCapture(capture);
  const raw = projectionRows.get(capture);
  if (!raw) fail("invalid_input");
  const values = (relation: string): Row[] => raw.get(relation) ?? [];
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
 * Source history remains in the operator-controlled source archive.
 */
export async function mapManagedRetainedBusiness(input: {
  capture: ManagedSourceCapture;
  issuer: string;
  freshTarget: ConnectedNativeStoreCapture;
  targetOwner: Pool;
}): Promise<{ packet: ConnectedNativeStoreCapture; identitySubjects: ManagedIdentityMappingResult["subjects"] }> {
  validateCapture(input.capture);
  const raw = projectionRows.get(input.capture);
  if (!raw) fail("invalid_input");
  const sourcePayments = raw.get("public.commerce_payments") ?? [];
  const sourceAttempts = raw.get("public.commerce_payment_attempts") ?? [];
  const sourceTransitions = raw.get("public.commerce_payment_state_transitions") ?? [];
  for (const intent of raw.get("public.commerce_payment_intents") ?? []) {
    if (intent.status !== "failed" && intent.status !== "succeeded") continue;
    const payment = sourcePayments.find(row => row.id === intent.payment_id);
    const attempts = sourceAttempts.filter(row => row.payment_intent_id === intent.id);
    const transitions = sourceTransitions.filter(row => row.payment_intent_id === intent.id);
    if (payment && attempts.length === 1 && transitions.length === 1
      && !attemptLinks(intent, payment, attempts[0], transitions[0]))
      fail("target_conflict", "public.commerce_payment_intents");
  }
  for (const entry of input.capture.dispositions)
    if (entry.rows && (uncarried.has(entry.relation)
      || stateClass.has(entry.relation) && !active.has(entry.relation)
        && entry.disposition === "requires-active-mapping"))
      fail("unsupported_table", entry.relation);
  const identitySource = managedIdentityEvidence(input.capture, input.issuer);
  const mapped = await mapManagedIdentityForConnectedRestore({ source: identitySource,
    freshTarget: input.freshTarget, targetOwner: input.targetOwner });
  const packet = mapped.packet;
  const values = (relation: string): Row[] => raw.get(`public.${relation}`) ?? [];
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
  const orderById = byId(orders), paymentById = byId(payments);
  const projected: Record<string, Row[]> = { catalog_products: [], catalog_skus: [], price_lists: [], price_entries: [],
    subscriptions: [], subscription_lines: [], subscription_cycles: [], subscription_events: [], subscription_renewal_terms: [],
    subscription_renewal_term_lines: [], commerce_orders: [], commerce_order_items: [],
    commerce_settlement_intents: [], commerce_settlement_transitions: [], outbox_events: [],
    invoicing_cutover: [], communication_recipient_consents: [] };
  for (const row of products) {
    // The target catalogue has no allergen column, so carrying this product would serve an empty safety list.
    if (!Array.isArray(row.allergens) || row.allergens.length) fail("unsupported_table", "public.catalog_products");
    projected.catalog_products!.push(project("catalog_products", row));
  }
  for (const row of skus) projected.catalog_skus!.push(project("catalog_skus", row));
  for (const row of priceLists) projected.price_lists!.push(project("price_lists", row));
  for (const row of priceEntries) projected.price_entries!.push(project("price_entries", row));
  const skuById = byId(skus), subscriptionById = byId(subscriptions);
  for (const row of subscriptions) {
    // starter_pack is a later-delivery discount promise with no typed target yet.
    if (row.status !== "active" || row.pet_id !== null || row.starter_pack !== null || row.is_test_fixture !== false
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
      // With no offset the instant depends on a session's zone; beyond microseconds the target would round it.
      || typeof consent.acceptedAt !== "string" || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$/.test(consent.acceptedAt)
      || !Number.isFinite(Date.parse(consent.acceptedAt))
      || typeof method.provider_mandate_ref !== "string" || !method.provider_mandate_ref
      || typeof method.provider_kind !== "string" || method.provider_kind.length > 64
      || method.client_id !== row.client_id || method.provider_method_ref !== row.payment_method_ref
      || method.method_kind !== "card" && method.method_kind !== "blik_payid"
      || row.payment_method_kind !== null && row.payment_method_kind !== method.method_kind)
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
      || current[0]!.variant_id !== row.variant_id || current[0]!.subscription_id !== row.subscription_id
      || typeof current[0]!.unit_price_gross_minor !== "number" || current[0]!.unit_price_gross_minor < 0)
      fail("target_conflict", "public.subscription_price_agreements");
    const agreement = current[0]!;
    // The source renews from the frozen quote line; the target renews from this agreement.
    const quoteLine = ((row.line_metadata as Row | null)?.productSnapshot as Row | undefined)?.quoteLine as Row | undefined;
    const quotedUnit = (quoteLine?.unitPriceGross as Row | undefined)?.amountMinor ?? quoteLine?.unitGrossMinor;
    if (quotedUnit !== undefined && Number(quotedUnit) !== agreement.unit_price_gross_minor
      || quoteLine?.quantity !== undefined && quoteLine.quantity !== row.qty)
      fail("target_conflict", "public.subscription_price_agreements");
    projected.subscription_lines!.push(project("subscription_lines", row, { quantity: row.qty,
      unit_price_minor: agreement.unit_price_gross_minor, currency_code: agreement.currency }));
    projected.subscription_renewal_term_lines!.push({ subscription_id: row.subscription_id,
      line_ordinal: Number(row.sort_order) + 1, sku: sku.sku, quantity: row.qty,
      unit_amount_minor: agreement.unit_price_gross_minor, created_at: row.created_at, updated_at: row.updated_at });
  }
  if (agreements.some(row => row.ended_at === null && !subscriptionLines.some(line => line.id === row.subscription_line_id))
    || methods.some(row => row.status === "active" && row.active === true && !subscriptionById.has(row.subscription_id)))
    fail("unsupported_table", "public.subscription_price_agreements");
  // A pending verification is live provider state with no typed target; other non-active statuses are ended history.
  if (methods.some(row => row.status === "pending_verification")) fail("unsupported_table", "public.commerce_payment_method_refs");
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
    // The target's evaluator hashes the trimmed lowercase address, so any other form would never match this consent.
    if (!contact || typeof contact.normalized_email !== "string" || contact.normalized_email !== contact.normalized_email.trim().toLowerCase() || !links.length
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
      // The transition holds the payment's own time; the intent's updated_at is when it was processed.
      paid_at: row.status === "paid" ? transitions.find(transition => transition.payment_intent_id === paidIntents[0]!.id)?.occurred_at : null,
      cancelled_at: null, refunded_at: null, metadata: row.metadata,
      currency_code: row.currency, total_amount_minor: row.total_cents, source_kind: row.source_kind,
      source_channel_id: null, source_order_ref: null, renewal_operation_id: null, renewal_operation_fingerprint: null });
  }
  for (const row of items) {
    if (!orderById.has(row.order_id) || typeof row.allocation_ordinal !== "number" || row.sku_id === null
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
    if (["cancelled", "expired"].includes(String(row.status)) && checkedTerminalUnpaid(row, raw)) continue;
    const order = orderById.get(row.order_id), payment = paymentById.get(row.payment_id);
    const ownAttempts = attempts.filter(attempt => attempt.payment_intent_id === row.id);
    const ownTransitions = transitions.filter(transition => transition.payment_intent_id === row.id);
    if (!order || !payment || payment.order_id !== row.order_id || row.target_kind !== "one_time_order"
      || row.subscription_id !== null || row.subscription_cycle_id !== null
      || !["created", "failed", "succeeded"].includes(String(row.status))
      || row.amount_cents !== order.total_cents || row.amount_cents !== payment.amount_cents
      || row.currency !== order.currency || row.currency !== payment.currency
      || typeof payment.provider !== "string" || !payment.provider || payment.provider.length > 64
      || (row.status === "created" && (payment.status !== "pending" || ownAttempts.length || ownTransitions.length
        || row.active_attempt_id !== null || payment.provider_payment_id !== null
          && row.provider_payment_id !== null && payment.provider_payment_id !== row.provider_payment_id))
      || (row.status === "failed" && (payment.status !== "failed" || ownAttempts.length !== 1
        || ownAttempts[0]?.status !== "failed" || ownTransitions.length !== 1 || ownTransitions[0]?.to_status !== "failed"
        || !attemptLinks(row, payment, ownAttempts[0], ownTransitions[0])))
      || (row.status === "succeeded" && (order.status !== "paid" || payment.status !== "succeeded"
        || ownAttempts.length !== 1 || ownAttempts[0]?.status !== "succeeded" || ownTransitions.length !== 1
        || ownTransitions[0]?.to_status !== "succeeded" || typeof row.provider_payment_id !== "string"
        || !row.provider_payment_id || !attemptLinks(row, payment, ownAttempts[0], ownTransitions[0]))))
      fail("target_conflict", "public.commerce_payment_intents");
    projected.commerce_settlement_intents!.push({ id: row.id, order_id: row.order_id,
      channel_key: payment.provider, status: row.status === "succeeded" ? "settled" : row.status, amount_minor: row.amount_cents,
      currency_code: row.currency, external_ref: row.provider_payment_id,
      open_idempotency_key: `managed-transfer-open:${digest(JSON.stringify([input.capture.sourceId,row.id]))}`,
      settled_at: row.status === "succeeded" ? ownTransitions[0]!.occurred_at : null,
      failure_reason: row.failure_reason, created_at: row.created_at, updated_at: row.updated_at,
      renewal_operation_id: null, renewal_operation_fingerprint: null });
    if (row.status === "failed" || row.status === "succeeded") {
      const transition = ownTransitions[0]!;
      // Carried history is before the target's invoicing boundary: without this
      // row the settled transition would open a new document duty after restore.
      if (row.status === "succeeded") projected.invoicing_cutover!.push({ source_kind: "paid", source_id: transition.id });
      projected.commerce_settlement_transitions!.push({ id: transition.id, intent_id: row.id,
        from_status: "created", to_status: row.status === "succeeded" ? "settled" : "failed",
        outcome: row.status === "succeeded" ? "succeeded" : "failed",
        idempotency_key: targetTransitionKey(transition.id),
        payload: { sourceId: input.capture.sourceId, sourceRowId: transition.id }, occurred_at: transition.occurred_at });
    }
  }
  if (payments.some(row => !intents.some(intent => intent.payment_id === row.id))
    || attempts.some(row => !intentById.has(row.payment_intent_id)
      || !["failed", "succeeded"].includes(String(row.status))
        && !checkedTerminalUnpaid(intentById.get(row.payment_intent_id), raw))
    || transitions.some(row => !intentById.has(row.payment_intent_id))) fail("unsupported_table", "public.commerce_payments");
  for (const row of outbox) {
    const order = orderById.get(row.aggregate_id), subscription = subscriptionById.get(row.aggregate_id);
    if (["processed", "discarded"].includes(String(row.status))) {
      // Discarded work the target would otherwise carry was never done, and the archive gives it no requeue path.
      if (row.status === "discarded" && (row.event_type === "commerce.order.paid" || row.event_type === "subscription.created"))
        fail("unsupported_table", "public.outbox_events");
      // The key alone stops the target's reminder scan sending a carried unpaid order a second reminder.
      if (row.event_type === "commerce.checkout_recovery" && row.aggregate_type === "commerce_order"
        && order?.status === "pending_payment" && row.idempotency_key === `checkout_recovery:1h:${row.aggregate_id}`)
        projected.outbox_events!.push(project("outbox_events", row, { payload: {}, error: null, metadata: {} }));
      continue;
    }
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
  for (const [table, rows] of Object.entries(projected)) await replaceTargetRows(packet, table, rows, input.targetOwner);
  const supportedHistory = new Set(["public.admin_audit_events", "public.payment_provider_settlement_batches",
    "public.payment_provider_settlement_items", "public.commerce_idempotency_keys",
    "public.communication_contacts", "public.communication_contact_links", "public.communication_email_deliveries",
    "public.payment_external_refs"]);
  for (const entry of input.capture.dispositions) if (entry.rows && history.has(entry.relation)
    && !active.has(entry.relation) && !supportedHistory.has(entry.relation)) fail("unsupported_table", entry.relation);
  const settlementBatches = values("payment_provider_settlement_batches");
  const settlementItems = values("payment_provider_settlement_items");
  for (const batch of settlementBatches) {
    const entries = settlementItems.filter(item => item.batch_id === batch.id);
    if (!entries.length || entries.some(item => item.provider_kind !== batch.provider_kind
      || item.currency !== batch.currency || typeof item.net_cents !== "number" || typeof item.fee_cents !== "number"
      || item.gross_cents !== item.net_cents + item.fee_cents
      || !intents.some(intent => intent.id === item.payment_intent_id && intent.status === "succeeded"
        && intent.payment_id === item.payment_id && intent.provider_payment_id === item.provider_payment_id
        && intent.amount_cents === item.gross_cents && intent.currency === item.currency
        && paymentById.get(intent.payment_id)?.provider === item.provider_kind))
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
  if (values("communication_email_deliveries").some(row => row.status !== "failed"))
    fail("unsupported_table", "public.communication_email_deliveries");
  return { packet, identitySubjects: mapped.subjects };
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
      // Restore compares this text at UTC, so a target session in another zone must not format it.
      const result = await owner.query<{ value: string }>(`SELECT pg_catalog.set_config('TimeZone','UTC',true) AS zone,pg_catalog.to_jsonb(p)::pg_catalog.text AS value
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

function validateCapture(capture: ManagedSourceCapture): void {
  if (!capture || !projectionRows.has(capture) || !Array.isArray(capture.dispositions)
    || typeof capture.sourceId !== "string" || !capture.sourceId
    || !capture.observation || typeof capture.observation.snapshot !== "string") fail("invalid_input");
  const { sha256, ...body } = capture;
  if (digest(JSON.stringify(body)) !== sha256) fail("invalid_input");
}
