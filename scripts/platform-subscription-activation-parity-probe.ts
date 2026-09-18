// Fixture half of the subscription-activation parity probe (wave C-D17): the identities the
// lifecycle runs on, the shared vocabulary its two bundles answer refusals in, and the seed and
// teardown each bundle needs to reach a comparable starting point. It is split out of the harness
// beside it so neither half has to grow past the repository's file limit to stay one story; the
// story itself is told in scripts/platform-subscription-activation-parity.ts.
//
// ⛔ No provider is named here: the settling channel is an opaque label, the currency is the code
// reserved for testing, and the only email is an input the MANAGED schema demands and stores itself.
import { createHash } from "node:crypto";

export type Row = Record<string, unknown>;
export type Conn = { query(text: string, values?: unknown[]): Promise<{ rows: Row[] }> };
export type Bundle = "node-postgres" | "managed";
export type Call = Row | { refused: string };

export const PROBE = "subscription_activation_probe";
export const AT = "2026-05-01T09:00:00.000Z";
export const SOURCE = "subscription-activation-probe";
// Opaque on both sides: the label of a channel that settles without contacting anything.
export const CHANNEL = "noop_payment", CURRENCY = "XTS", CADENCE = 28, TOTAL = 3900;
export const SKU_SELLABLE = "probe-sku-sellable", SKU_EMPTY = "probe-sku-empty";
export const fixed = (group: number, index: number): string =>
  `7d2a0f10-${group.toString().padStart(4, "0")}-4000-8000-${index.toString().padStart(12, "0")}`;
export const CLIENT = fixed(1, 1);
export const PRODUCT = fixed(4, 1), SKU_ROW = fixed(4, 2);
export const ORDERS = [1, 2, 3, 4, 5].map((n) => fixed(3, n)), order = (n: number): string => fixed(3, n);
// The invalid TLD keeps a stray delivery impossible. It is an INPUT only, and only where the
// managed schema stores contacts itself; the neutral continuation never sees it.
export const MAIL = "subscription-activation-probe@example.invalid";
export const CONTACT_REF = hex("contact"), CONSENT_REF = hex("consent"), OTHER_CONTACT_REF = hex("other-contact");
export const CAPTURED = "captured-subscription-activation-1", RECAPTURED = "captured-subscription-activation-2";

/** The two bundles' names for the SAME refusal. Drift lands as `unclassified:` and fails the diff. */
export const REFUSAL: Record<string, string> = {
  subscription_activation_order_not_paid: "activation_order_not_paid",
  subscription_activation_payment_not_succeeded: "activation_order_not_paid",
  subscription_activation_payment_fingerprint_conflict: "activation_payment_identity_conflict",
  subscription_activation_idempotency_conflict: "activation_payment_identity_conflict",
  subscription_activation_invalid_input: "activation_invalid_input",
  // Kernel-only below: upstream has no counterpart, or records instead of refusing.
  commerce_offer_continuation_offer_available: "continuation_offer_available",
  commerce_offer_continuation_invalid_input: "continuation_invalid_input",
  subscription_activation_order_compensated: "activation_order_compensated",
  subscription_activation_not_declared: "activation_not_declared",
  subscription_activation_declaration_conflict: "activation_declaration_conflict",
  commerce_checkout_compensation_key_conflict: "compensation_key_conflict",
  commerce_checkout_compensation_invalid_input: "compensation_invalid_input",
};

export const stable = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
/** The compensation flag a bundle answered with, and `null` where it refused instead of answering. */
export const cancelledFlag = (answer: Call): unknown => ("refused" in answer ? undefined : answer.cancelled) ?? null;
export const first = (e: unknown): string => String((e as { message?: unknown }).message ?? e).split("\n")[0]!.trim();
export const classify = (error: unknown): string => REFUSAL[first(error)] ?? `unclassified:${first(error)}`;
export function hex(seed: string): string {
  return createHash("sha256").update(`${SOURCE}:${seed}`).digest("hex");
}
/** The opaque identity of a captured payment, derived the way the direct adapter derives it. */
export const fingerprint = (reference: string): string => createHash("sha256").update(reference).digest("hex");
export async function call(connection: Conn, text: string, values: unknown[] = []): Promise<Call> {
  try { return ((await connection.query(text, values)).rows[0]?.response ?? {}) as Row; }
  catch (error) { if (process.env.PARITY_DEBUG) process.stderr.write(`refused ${first(error)}\n${text}\n`); return { refused: classify(error) }; }
}
export const count = async (sql: Conn, text: string, values: unknown[] = []): Promise<number> =>
  Number(Object.values((await sql.query(text, values)).rows[0] ?? { n: 0 })[0]);
/** Insert one row supplying whatever the table demands WITHOUT naming a column of it. */
async function fillRequired(sql: Conn, table: string, given: Row, reuse = false): Promise<void> {
  const { rows } = await sql.query(`SELECT col.column_name AS name, col.data_type AS kind,
      (SELECT string_agg(pg_get_constraintdef(rule.oid), ' ') FROM pg_constraint rule
        WHERE rule.conrelid = ('public.' || $1)::regclass AND rule.contype = 'c'
          AND pg_get_constraintdef(rule.oid) LIKE '%' || col.column_name || '%') AS allowed
    FROM information_schema.columns col WHERE col.table_schema = 'public' AND col.table_name = $1
      AND col.is_nullable = 'NO' AND col.column_default IS NULL`, [table]);
  const values: Row = { ...given };
  for (const row of rows.filter((entry) => !(String(entry.name) in values))) {
    const choices = String(row.allowed ?? "").match(/'[^']*'::text/g) ?? [];
    values[String(row.name)] = row.kind === "text" ? choices.at(0)?.slice(1, -7) ?? `probe-${String(row.name)}`
      : row.kind === "jsonb" ? "{}" : 1;
  }
  const names = Object.keys(values);
  await sql.query(`INSERT INTO public.${table} (${names.join(", ")}) VALUES (${
    names.map((_, i) => `$${i + 1}`).join(", ")})${reuse ? " ON CONFLICT DO NOTHING" : ""}`, Object.values(values));
}

/** O1 activates, O2 is compensated, O3 is the gap this kernel repairs, O4 is never paid for. */
export async function seed(sql: Conn, bundle: Bundle): Promise<void> {
  const managed = bundle === "managed";
  await sql.query("BEGIN");
  await fillRequired(sql, "clients", { id: CLIENT, email: MAIL }, true);
  const owners: Row = {};
  if (managed) {
    // Whatever upstream's OWN activation refuses to work without is seeded here, discovered from
    // its definition rather than restated: the harness must not have to know what a buyer's other
    // belongings are called in a schema it does not own.
    for (const { column, table, id } of await ownerPlan(sql)) {
      if (table !== null) await fillRequired(sql, table, { id, client_id: CLIENT }, true);
      owners[column] = table === null ? CLIENT : id;
    }
    await fillRequired(sql, "catalog_products", { id: PRODUCT }, true);
    await fillRequired(sql, "catalog_skus", { id: SKU_ROW, product_id: PRODUCT, sku: SKU_SELLABLE }, true);
    // Whose stock feed this is comes OUT of the database: upstream keys provider stock on a
    // registry row, and reading that key back is how this harness avoids writing a vendor name.
    const source = String((await sql.query(
      `SELECT kind FROM public.providers ORDER BY kind LIMIT 1`)).rows[0]?.kind ?? "");
    for (const [sku, quantity] of [[SKU_SELLABLE, 10], [SKU_EMPTY, 0]] as const)
      await fillRequired(sql, "fulfillment_provider_stock_current", {
        provider_kind: source, sku, provider_total_quantity: quantity,
        provider_for_sale_quantity: quantity, provider_reserved_unavailable_quantity: 0,
        last_synced_at: AT, stale_after: "2999-01-01T00:00:00.000Z", sync_run_id: SOURCE }, true);
  } else {
    for (const [sku, quantity] of [[SKU_SELLABLE, 10], [SKU_EMPTY, 0]] as const)
      await fillRequired(sql, "fulfillment_stock_current", {
        source_key: SOURCE, sku, total_quantity: quantity, for_sale_quantity: quantity,
        reserved_unavailable_quantity: 0, last_synced_at: AT, stale_after: "2999-01-01T00:00:00.000Z",
        sync_run_id: SOURCE, idempotency_key: `${SOURCE}-${sku}`, operation_fingerprint: `${SOURCE}-${sku}` }, true);
  }
  for (const id of ORDERS) {
    await fillRequired(sql, "commerce_orders", { id, client_id: CLIENT, status: "pending_payment",
      ...(managed ? { ...owners, mode: "one_time", currency: CURRENCY, region_code: "ZZ",
        subtotal_cents: TOTAL, discount_cents: 0, shipping_cents: 0,
        shipping_discount_cents: 0, tax_cents: 0, total_cents: TOTAL,
        metadata: JSON.stringify({ checkoutIntent: "subscription_initial",
          quoteSnapshot: { quote: { context: { mode: "subscription_initial", cadenceDays: CADENCE } } } }) }
        : { currency_code: CURRENCY, total_amount_minor: TOTAL }) });
    await fillRequired(sql, "commerce_order_items", managed
      ? { order_id: id, sku_id: SKU_ROW, allocation_ordinal: 1, quantity: 1, unit_price_cents: TOTAL,
          total_cents: TOTAL, discount_allocated_cents: 0, effective_total_cents: TOTAL,
          effective_net_cents: TOTAL, vat_rate_bps: 0, mode_at_line: "one_time" }
      : { order_id: id, line_ordinal: 1, quantity: 1, unit_amount_minor: TOTAL, line_amount_minor: TOTAL });
  }
  await sql.query("COMMIT");
}

/** Teardown for the SHARED managed slot only, in foreign-key order. Nothing is read back: a
 *  deleted row proves nothing. The kernel bundle needs none of this -- it creates and drops its
 *  own database. */
export async function unseed(sql: Conn): Promise<void> {
  const drop = async (text: string, values: unknown[]): Promise<void> =>
    void await sql.query(text, values).catch(() => undefined);
  const mine = "IN (SELECT id FROM public.subscriptions WHERE client_id = $1)";
  const intents = "IN (SELECT id FROM public.commerce_payment_intents WHERE order_id = ANY($1::uuid[]))";
  for (const [table, predicate] of [
    ["subscription_lines", `subscription_id ${mine}`],
    ["subscription_events", `subscription_id ${mine}`],
    ["subscription_cycles", `subscription_id ${mine}`]] as const)
    await drop(`DELETE FROM public.${table} WHERE ${predicate}`, [CLIENT]);
  for (const [table, predicate] of [
    ["commerce_payment_state_transitions", `payment_intent_id ${intents}`],
    ["commerce_payment_attempts", `payment_intent_id ${intents}`],
    ["commerce_payments", "order_id = ANY($1::uuid[])"],
    ["commerce_payment_intents", "order_id = ANY($1::uuid[])"],
    ["commerce_order_items", "order_id = ANY($1::uuid[])"],
    ["outbox_events", "aggregate_id = ANY($1::uuid[])"],
    ["commerce_orders", "id = ANY($1::uuid[])"]] as const)
    await drop(`DELETE FROM public.${table} WHERE ${predicate}`, [ORDERS]);
  await drop(`DELETE FROM public.subscriptions WHERE client_id = $1`, [CLIENT]);
  for (const [table, predicate, value] of [
    ["commerce_idempotency_keys", "idempotency_key LIKE", `${SOURCE}%`],
    // ⚠️ MEASURED: upstream's attempt verb enqueues a queue row keyed on the PAYMENT INTENT, not on
    // the order, so deleting by aggregate above leaves it and the next run collides on its key.
    ["outbox_events", "idempotency_key LIKE", `${SOURCE}%`],
    ["commerce_product_stock_notifications", "email LIKE", `%${MAIL}`],
    ["fulfillment_provider_stock_current", "sync_run_id =", SOURCE],
    ["catalog_skus", "id =", SKU_ROW], ["catalog_products", "id =", PRODUCT]] as const)
    await drop(`DELETE FROM public.${table} WHERE ${predicate} $1`, [value]);
  for (const { table, id } of await ownerPlan(sql))
    if (table !== null) await drop(`DELETE FROM public.${table} WHERE id = $1`, [id]);
  await drop(`DELETE FROM public.clients WHERE id = $1`, [CLIENT]);
}

/**
 * The owner columns upstream's activation names in its own refusal, and the table each one points
 * at. Read out of the function definition, so nothing about the managed schema's vocabulary is
 * written into this file — and so a rename upstream is a seeding failure rather than a silent
 * divergence in the golden.
 */
async function ownerPlan(sql: Conn): Promise<{ column: string; table: string | null; id: string }[]> {
  const { rows } = await sql.query(`SELECT pg_get_functiondef(routine.oid) AS body
    FROM pg_proc routine JOIN pg_namespace space ON space.oid = routine.pronamespace
    WHERE space.nspname = 'public' AND routine.proname = 'subscription_activate_from_paid_checkout_order'`);
  const guard = /IF ([^;]*?IS NULL[^;]*?)\s+THEN\s+RAISE EXCEPTION 'subscription_activation_missing/
    .exec(String(rows[0]?.body ?? ""))?.[1] ?? "";
  const plan: { column: string; table: string | null; id: string }[] = [];
  for (const [index, match] of [...guard.matchAll(/v_order\.(\w+) IS NULL/g)].entries()) {
    const column = match[1]!;
    const target = (await sql.query(`SELECT rule.confrelid::regclass::text AS target
      FROM pg_constraint rule
      WHERE rule.conrelid = 'public.commerce_orders'::regclass AND rule.contype = 'f'
        AND rule.conkey = ARRAY[(SELECT column_attribute.attnum FROM pg_attribute column_attribute
          WHERE column_attribute.attrelid = 'public.commerce_orders'::regclass
            AND column_attribute.attname = $1)]`, [column])).rows[0]?.target;
    const table = String(target ?? "").replace(/^public\./, "");
    plan.push({ column, table: table === "clients" || table === "" ? null : table, id: fixed(2, index + 1) });
  }
  return plan;
}

/** Which columns a table actually has: the only honest way to assert that a value is NOT stored. */
export const columnsOf = async (sql: Conn, table: string): Promise<Row> => ({
  columns: (await sql.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table]))
    .rows.map((row) => String(row.column_name)) });
