// An order may hold more than one fulfilment row: the original at `sequence_no` 0 and a
// replacement parcel at 1, 2, ... Several reads still have to answer with exactly one, and
// they must all answer the same way, or the operator, the customer and the support agent
// each see a different parcel for the same order.
//
// The rule, fixed once here: the parcel that *currently represents the order* is the highest
// `sequence_no`, tie-broken by `id` descending. While every order has exactly one row - which
// is every order until an operator can request a replacement - each function below returns
// that row, so the reads calling them are unchanged.
//
// This module is the single owner of that rule. It was four near-copies across two adapters
// and two read models before they were merged; keep it one.

export type FulfillmentParcelRow = { id?: unknown; order_id?: unknown; sequence_no?: unknown };

// A row read without the column, or by a query that does not select it, is the original
// parcel - `sequence_no` carries a database default of 0 for exactly the same reason.
export function parcelSequenceNo(row: FulfillmentParcelRow): number {
  return typeof row.sequence_no === "number" ? row.sequence_no : 0;
}

// Negative when `left` is the more current parcel, so this sorts the current parcel first.
// Plain codepoint order on `id`, never `localeCompare`: this has to agree with SQL's
// `ORDER BY id DESC` over a uuid, and a collation that folds hyphens or case would not.
export function compareParcelPrecedence(left: FulfillmentParcelRow, right: FulfillmentParcelRow): number {
  const bySequence = parcelSequenceNo(right) - parcelSequenceNo(left);
  if (bySequence !== 0) return bySequence;
  const leftId = String(left.id ?? "");
  const rightId = String(right.id ?? "");
  if (leftId === rightId) return 0;
  return leftId < rightId ? 1 : -1;
}

export function currentParcel<Row extends FulfillmentParcelRow>(rows: readonly Row[]): Row | null {
  return rows.reduce<Row | null>(
    (best, row) => (best === null || compareParcelPrecedence(row, best) < 0 ? row : best),
    null,
  );
}

export function currentParcelFor<Row extends FulfillmentParcelRow>(
  rows: readonly Row[],
  orderId: unknown,
): Row | null {
  return currentParcel(rows.filter((row) => row.order_id === orderId));
}

export function currentParcelPerOrder<Row extends FulfillmentParcelRow>(
  rows: readonly Row[],
): Map<string, Row> {
  const byOrder = new Map<string, Row>();
  for (const row of rows) {
    const orderId = String(row.order_id ?? "");
    const incumbent = byOrder.get(orderId);
    if (!incumbent || compareParcelPrecedence(row, incumbent) < 0) byOrder.set(orderId, row);
  }
  return byOrder;
}

// For consumers that take `[0]` of an order's rows after filtering by `order_id`. Grouping
// preserves each order's first-appearance position, so a result that already holds one row
// per order comes back in exactly the order it arrived.
export function currentParcelFirst<Row extends FulfillmentParcelRow>(rows: readonly Row[]): Row[] {
  const byOrder = new Map<string, Row[]>();
  for (const row of rows) {
    const key = String(row.order_id ?? "");
    const group = byOrder.get(key);
    if (group) group.push(row);
    else byOrder.set(key, [row]);
  }
  return [...byOrder.values()].flatMap((group) => (group.length > 1 ? [...group].sort(compareParcelPrecedence) : group));
}

// A companion row - a tracking ref, an operation, an evidence row - names the parcel it was
// written for. Attribution is the rule the OMS summary already applies to every other companion;
// tracking refs only joined it once `shipment_external_refs.fulfillment_order_id` existed.
//
// A row whose attribution is absent belongs to whichever parcel is asking. That is exactly the
// answer every reader gave before the column existed, so no ref a writer left unattributed can
// vanish from a customer's page - the narrowing can only ever remove a *sibling parcel's* ref.
export type ParcelAttributedRow = { fulfillment_order_id?: unknown };

export function belongsToParcel(row: ParcelAttributedRow, parcelId: unknown): boolean {
  const attributed = row.fulfillment_order_id;
  if (typeof attributed !== "string" || !attributed) return true;
  return typeof parcelId === "string" && parcelId ? attributed === parcelId : true;
}

export function rowsForParcel<Row extends ParcelAttributedRow>(
  rows: readonly Row[],
  parcelId: unknown,
): Row[] {
  return rows.filter((row) => belongsToParcel(row, parcelId));
}
