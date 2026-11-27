import type { StorefrontObserver } from "./contracts.js";

// Each read also reports the two session settings it ran under, so a read that
// did not run inside this observer's own transaction is refused, not trusted.
const SESSION_COLUMNS = `current_setting('row_security') AS row_security,
  current_setting('transaction_read_only') AS transaction_read_only`;

// One statement per ledger. `s` holds the subject's orders; each count is its
// own scalar subquery over `s`, so no join multiplies another count.
const LEDGER_SQL = `WITH s AS (
  SELECT o.id, o.status
  FROM public.commerce_orders o
  JOIN public.clients c ON c.id = o.client_id
  WHERE lower(c.email) = lower($1::text)
)
SELECT
  ${SESSION_COLUMNS},
  (SELECT count(*) FROM s) AS orders,
  (SELECT count(*) FROM s WHERE s.status = 'pending_payment') AS payable_orders,
  (SELECT count(DISTINCT r.purchase_order_id) FROM public.fulfillment_inventory_reservations r
    WHERE r.purchase_order_id IN (SELECT id FROM s) AND r.status = 'held') AS holds,
  (SELECT count(*) FROM public.payment_simulator_attempts a
    JOIN public.commerce_settlement_intents i ON i.id = a.settlement_intent_id
    WHERE i.order_id IN (SELECT id FROM s))
  + (SELECT count(*) FROM public.payment_provider_attempts a
    JOIN public.commerce_settlement_intents i ON i.id = a.settlement_intent_id
    WHERE i.order_id IN (SELECT id FROM s) AND a.status <> 'blocked_preflight') AS attempts,
  (SELECT count(*) FROM public.payment_simulator_attempts a
    JOIN public.commerce_settlement_intents i ON i.id = a.settlement_intent_id
    WHERE i.order_id IN (SELECT id FROM s) AND a.state = 'captured')
  + (SELECT count(*) FROM public.payment_provider_attempts a
    JOIN public.commerce_settlement_intents i ON i.id = a.settlement_intent_id
    WHERE i.order_id IN (SELECT id FROM s) AND a.status = 'succeeded') AS captures`;

const DATABASE_PAYABLE_SQL = `SELECT
  ${SESSION_COLUMNS},
  (SELECT count(*) FROM public.commerce_orders WHERE status = 'pending_payment') AS payable_orders`;

type Executor = {
  query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
};

function inputInvalid(detail: string): TypeError {
  return new TypeError(`storefront_observer_input_invalid: ${detail} Pass an executor with query(text, values), options { exclusive?: boolean } and a subject e-mail without surrounding whitespace.`);
}

function countInvalid(detail: string): Error {
  return new Error(`storefront_observer_count_invalid: ${detail} The ledger is not read as zero; check the executor and the platform schema.`);
}

const SESSION_INVALID = "storefront_observer_session_invalid: the ledger read did not run inside the observer's own READ ONLY transaction with row security off."
  + " Cause: the executor sends statements to more than one database session, or the session was already inside a transaction."
  + " Fix: pass an executor over one session, such as asPostgresSqlExecutor(await pool.connect()), and call the observer outside a transaction."
  + " Recheck: run the scenario again with that executor.";

const ROW_SECURITY = "storefront_observer_row_security: the reading role is subject to row-level security on a table the ledger reads."
  + " Cause: with row security the role would see filtered rows and read the ledger as zeros, so the observer turns it off and PostgreSQL refuses the read."
  + " Fix: read as the owner of the platform tables or as a role with BYPASSRLS, in addition to SELECT on the six tables."
  + " Recheck: run the scenario again with that executor.";

/** A count from PostgreSQL `bigint` text, or a number some drivers already parsed; anything else refuses. */
function count(row: Readonly<Record<string, unknown>>, column: string): number {
  const value = row[column];
  const parsed = typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value) ? Number(value)
    : typeof value === "number" ? value : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw countInvalid(`${column} is not a non-negative safe integer.`);
  return parsed;
}

function isRowSecurityRefusal(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === "42501" && /row-level security/i.test(error.message);
}

/**
 * Runs one read in its own READ ONLY transaction with row security off, checks
 * that the read ran there and that its counts are readable, and ends the
 * transaction: COMMIT after a read it accepts, ROLLBACK after any failure.
 */
async function readOnce<T>(executor: Executor, text: string, values: readonly unknown[], parse: (row: Readonly<Record<string, unknown>>) => T): Promise<T> {
  try {
    await executor.query("BEGIN READ ONLY");
    await executor.query("SET LOCAL row_security = off");
    const { rows } = await executor.query(text, values);
    const [row] = rows;
    if (rows.length !== 1 || row === undefined) throw countInvalid(`the statement answered ${rows.length} rows, not one.`);
    if (row.row_security !== "off" || row.transaction_read_only !== "on") throw new Error(SESSION_INVALID);
    const parsed = parse(row);
    await executor.query("COMMIT");
    return parsed;
  } catch (error) {
    await executor.query("ROLLBACK").catch(() => undefined);
    throw isRowSecurityRefusal(error) ? new Error(ROW_SECURITY, { cause: error }) : error;
  }
}

/**
 * A storefront observer over the platform's own PostgreSQL tables, so a
 * PostgreSQL-tier proof needs no store-written observer. `executor` is any
 * object with `query(text, values)` resolving `{ rows }` over one database
 * session, for example `asPostgresSqlExecutor(await pool.connect())` from
 * `@openlup/platform/data`; this entry imports no database client.
 *
 * `ledger(subject)` finds the subject's orders through the client whose e-mail
 * equals the subject case-insensitively: `orders` in any status;
 * `payableOrders` in `pending_payment`; `holds` orders with at least one
 * `held` stock reservation; `attempts` simulator attempts and provider attempts
 * on their settlement intents, except provider attempts `blocked_preflight`
 * (refused before reaching the provider; a `created` one counts); `captures`
 * captured simulator attempts and succeeded provider attempts, one per
 * capture. Each count is its own subquery, so no join multiplies another. The
 * subject is the run's e-mail as given and must carry no surrounding
 * whitespace; otherwise the read rejects `storefront_observer_input_invalid`.
 *
 * Every read is one statement in its own `BEGIN READ ONLY` transaction with
 * `SET LOCAL row_security = off`, ended by `COMMIT`, or `ROLLBACK` after any
 * failure, so call the observer outside a transaction. With row security off a
 * role subject to a row-level security policy is refused by PostgreSQL instead
 * of reading filtered rows; the observer rejects that as
 * `storefront_observer_row_security`. The reading role therefore needs `SELECT`
 * on `commerce_orders`, `clients`, `fulfillment_inventory_reservations`,
 * `commerce_settlement_intents`, `payment_simulator_attempts` and
 * `payment_provider_attempts` and must own those tables or have `BYPASSRLS`;
 * the grants alone are not sufficient. A read that did not run in its own
 * transaction (an executor over several sessions) rejects
 * `storefront_observer_session_invalid`.
 *
 * With `exclusive: true` it adds `payableOrdersInDatabase()`, every payable
 * order in the database. Set it only when the database is exclusive to one
 * run: the runner then requires that the payable orders added in the database
 * equal those added for the run's subjects. Each call is its own transaction,
 * so `ledger` and `payableOrdersInDatabase` read separate snapshots.
 *
 * A count that is not a non-negative safe integer, or an answer that is not
 * one row, rejects `storefront_observer_count_invalid`, never zero; any other
 * executor rejection is passed through. A host whose records live elsewhere
 * supplies its own observer.
 *
 * @experimental
 */
export function createPostgresStorefrontObserver(executor: Executor, options?: { readonly exclusive?: boolean }): StorefrontObserver {
  if (typeof executor !== "object" || executor === null || typeof executor.query !== "function") {
    throw inputInvalid("executor has no query function.");
  }
  if (options !== undefined && (typeof options !== "object" || options === null)) throw inputInvalid("options is not an object.");
  const exclusive = options?.exclusive;
  if (exclusive !== undefined && typeof exclusive !== "boolean") throw inputInvalid("options.exclusive is not a boolean.");
  const ledger = async (subject: string) => {
    if (typeof subject !== "string" || subject.length === 0 || subject.trim() !== subject) {
      throw inputInvalid("the subject is not a non-empty string without surrounding whitespace.");
    }
    return readOnce(executor, LEDGER_SQL, [subject], (row) => ({
      orders: count(row, "orders"),
      payableOrders: count(row, "payable_orders"),
      holds: count(row, "holds"),
      attempts: count(row, "attempts"),
      captures: count(row, "captures"),
    }));
  };
  if (exclusive !== true) return Object.freeze({ kind: "package", ledger });
  return Object.freeze({
    kind: "package",
    ledger,
    payableOrdersInDatabase: () => readOnce(executor, DATABASE_PAYABLE_SQL, [], (row) => count(row, "payable_orders")),
  });
}
