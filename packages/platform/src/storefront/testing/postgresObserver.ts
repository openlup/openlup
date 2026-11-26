import type { StorefrontObserver } from "./contracts.js";

// One statement per ledger. `s` holds the subject's orders; each count is its
// own scalar subquery over `s`, so no join multiplies another count.
const LEDGER_SQL = `WITH s AS (
  SELECT o.id, o.status
  FROM public.commerce_orders o
  JOIN public.clients c ON c.id = o.client_id
  WHERE lower(c.email) = lower($1::text)
)
SELECT
  (SELECT count(*) FROM s) AS orders,
  (SELECT count(*) FROM s WHERE s.status = 'pending_payment') AS payable_orders,
  (SELECT count(DISTINCT r.purchase_order_id) FROM public.fulfillment_inventory_reservations r
    WHERE r.purchase_order_id IN (SELECT id FROM s) AND r.status = 'held') AS holds,
  (SELECT count(*) FROM public.payment_simulator_attempts a
    JOIN public.commerce_settlement_intents i ON i.id = a.settlement_intent_id
    WHERE i.order_id IN (SELECT id FROM s))
  + (SELECT count(*) FROM public.payment_provider_attempts a
    JOIN public.commerce_settlement_intents i ON i.id = a.settlement_intent_id
    WHERE i.order_id IN (SELECT id FROM s)) AS attempts,
  (SELECT count(*) FROM public.payment_simulator_attempts a
    JOIN public.commerce_settlement_intents i ON i.id = a.settlement_intent_id
    WHERE i.order_id IN (SELECT id FROM s) AND a.state = 'captured')
  + (SELECT count(*) FROM public.payment_provider_attempts a
    JOIN public.commerce_settlement_intents i ON i.id = a.settlement_intent_id
    WHERE i.order_id IN (SELECT id FROM s) AND a.status = 'succeeded') AS captures`;

const DATABASE_PAYABLE_SQL = `SELECT count(*) AS payable_orders FROM public.commerce_orders WHERE status = 'pending_payment'`;

type Executor = {
  query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
};

function inputInvalid(detail: string): TypeError {
  return new TypeError(`storefront_observer_input_invalid: ${detail} Pass an executor with query(text, values) and options { exclusive?: boolean }.`);
}

function countInvalid(detail: string): Error {
  return new Error(`storefront_observer_count_invalid: ${detail} The ledger is not read as zero; check the executor and the platform schema.`);
}

/** A count from PostgreSQL `bigint` text, or a number some drivers already parsed; anything else refuses. */
function count(row: Readonly<Record<string, unknown>>, column: string): number {
  const value = row[column];
  const parsed = typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value) ? Number(value)
    : typeof value === "number" ? value : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw countInvalid(`${column} is not a non-negative safe integer.`);
  return parsed;
}

async function onlyRow(executor: Executor, text: string, values: readonly unknown[]): Promise<Readonly<Record<string, unknown>>> {
  const { rows } = await executor.query(text, values);
  const [row] = rows;
  if (rows.length !== 1 || row === undefined) throw countInvalid(`the statement answered ${rows.length} rows, not one.`);
  return row;
}

/**
 * A storefront observer over the platform's own PostgreSQL tables, so a
 * PostgreSQL-tier proof needs no store-written observer. `executor` is any
 * object with `query(text, values)` resolving `{ rows }`, for example a
 * `SqlExecutor` from `@openlup/core/readiness` or `asPostgresSqlExecutor(client)`
 * from `@openlup/platform/data`; this entry imports no database client.
 *
 * `ledger(subject)` runs one read-only statement whose only parameter is the
 * subject, and finds the subject's orders through the client whose e-mail
 * equals it case-insensitively: `orders` in any status; `payableOrders` in
 * `pending_payment`; `holds` orders with at least one `held` stock reservation;
 * `attempts` simulator and provider payment attempts on their settlement
 * intents; `captures` captured simulator attempts and succeeded provider
 * attempts, one per capture. Each count is its own subquery, so no join
 * multiplies another. The observer writes, locks and controls no transaction;
 * a harness may run it inside `BEGIN READ ONLY`.
 *
 * With `exclusive: true` it adds `payableOrdersInDatabase()`, every payable
 * order in the database. Set it only when the database is exclusive to one
 * run: the runner then requires that the payable orders added in the database
 * equal those added for the run's subjects.
 *
 * The executor needs `SELECT` on `commerce_orders`, `clients`,
 * `fulfillment_inventory_reservations`, `commerce_settlement_intents`,
 * `payment_simulator_attempts` and `payment_provider_attempts`. A count that is
 * not a non-negative safe integer, or an answer that is not one row, rejects
 * `storefront_observer_count_invalid`, never zero; an executor's rejection is
 * passed through. A host whose records live elsewhere supplies its own
 * observer.
 *
 * @experimental
 */
export function createPostgresStorefrontObserver(
  executor: { query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }> },
  options?: { readonly exclusive?: boolean },
): StorefrontObserver {
  if (typeof executor !== "object" || executor === null || typeof executor.query !== "function") {
    throw inputInvalid("executor has no query function.");
  }
  if (options !== undefined && (typeof options !== "object" || options === null)) throw inputInvalid("options is not an object.");
  const exclusive = options?.exclusive;
  if (exclusive !== undefined && typeof exclusive !== "boolean") throw inputInvalid("options.exclusive is not a boolean.");
  const ledger = async (subject: string) => {
    const row = await onlyRow(executor, LEDGER_SQL, [subject]);
    return {
      orders: count(row, "orders"),
      payableOrders: count(row, "payable_orders"),
      holds: count(row, "holds"),
      attempts: count(row, "attempts"),
      captures: count(row, "captures"),
    };
  };
  if (exclusive !== true) return Object.freeze({ kind: "package", ledger });
  return Object.freeze({
    kind: "package",
    ledger,
    payableOrdersInDatabase: async () => count(await onlyRow(executor, DATABASE_PAYABLE_SQL, []), "payable_orders"),
  });
}
