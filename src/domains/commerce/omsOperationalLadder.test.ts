import { effectiveFunctionBody } from "../../test/effectiveMigration";
import { describe, expect, it } from "vitest";
import * as commerce from "@openlup/platform/commerce";

import type { AdminCommerceOrdersListResponse } from "./omsContracts.js";
import { summarizeOmsListTotals } from "./omsListTotals.js";
import * as facade from "./omsOperationalLadder.js";
import { summarizeOmsListOrders } from "./omsReadModelListSummary.js";

const migration = effectiveFunctionBody("commerce_oms_admin_list_queue");

type ListOrder = AdminCommerceOrdersListResponse["orders"][number];

it("preserves package export identity", () => {
  expect(Object.keys(facade).sort()).toEqual([
    "OMS_ATTENTION_PRIORITY_FALLBACK_RANK",
    "OMS_ATTENTION_PRIORITY_LADDER",
    "OMS_OPERATIONAL_LADDER",
    "OMS_OPERATIONAL_LADDER_FALLBACK",
    "resolveOmsOperationalState",
  ]);
  for (const [name, value] of Object.entries(facade)) {
    expect(value).toBe(commerce[name as keyof typeof commerce]);
  }
});

describe("fixture-path summarizers versus the SQL counters", () => {
  // summarizeOmsListOrders never executes on the SQL-backed path - the query
  // always supplies summaryCounts - but it IS the counter for the fixture bundle
  // and for fixtures. These two counter sets must agree or the same queue
  // reports different numbers depending on which adapter served it.
  it("counts the same nine buckets, in the same order, over the same predicates", () => {
    const sqlCounters = parseSummaryCounters(migration);
    const rows = counterFixture();
    const counted = summarizeOmsListOrders(rows);

    expect(Object.keys(counted)).toEqual(sqlCounters.map((counter) => counter.key));
    for (const counter of sqlCounters) {
      const expected = rows.filter(translateCounterPredicate(counter.predicate)).length;
      expect(
        { key: counter.key, count: counted[counter.key as keyof typeof counted] },
        `summary counter ${counter.key} (SQL: ${counter.predicate})`,
      ).toEqual({ key: counter.key, count: expected });
      // A bucket that is empty in the fixture proves nothing about the predicate.
      expect(expected, `fixture must exercise ${counter.key}`).toBeGreaterThan(0);
    }

    // The fixture's discriminating power, pinned: nine equal counts would let a
    // counter keep passing with another bucket's predicate.
    const counts = Object.values(counted);
    expect(new Set(counts).size, `counter fixture must separate all buckets: ${counts.join(",")}`).toBe(
      counts.length,
    );
  });

  it("agrees with the SQL paid-summary counters on gmv, aov and order count", () => {
    const paid = parsePaidSummary(migration);
    expect(paid.paymentPredicate).toBe("payment.payment_status = 'succeeded'");
    expect(paid.amountMinorExpression).toBe("coalesce(sum(orders.total_cents)::bigint, 0)");
    expect(paid.orderCountExpression).toBe("count(*)::integer");

    const totals = summarizeOmsListTotals([
      totalsOrder({ paymentStatus: "succeeded", amountMinor: 10_000 }),
      totalsOrder({ paymentStatus: "succeeded", amountMinor: 20_500, mode: "subscription_cycle" }),
      totalsOrder({ paymentStatus: "processing", amountMinor: 99_900 }),
    ]);

    expect(totals.gmv.amountMinor).toBe(30_500);
    expect(totals.orderCount).toBe(2);
    // SQL: round(amount_minor::numeric / order_count)::bigint
    expect(totals.aov.amountMinor).toBe(Math.round(30_500 / 2));
  });

  // ---------------------------------------------------------------------
  // KNOWN LATENT DIVERGENCE (a) - subscription-cycle counter.
  // Named here rather than silently passing. Neither half is reachable today:
  // on the SQL-backed path the query supplies summaryTotals and this summariser is
  // never called, and the fixture bundle has no second aggregation to disagree
  // with. Both become live divergences the moment a caller compares them.
  // ---------------------------------------------------------------------


  it("records that the TS subscription counter omits the SQL subscription_id filter", () => {
    const paid = parsePaidSummary(migration);
    expect(paid.subscriptionFilter).toBe(
      "orders.mode = 'subscription_cycle' AND orders.subscription_id IS NOT NULL",
    );

    // A subscription_cycle order with no subscription_id: SQL excludes it, TS
    // counts it. The assertion pins the CURRENT disagreement, on purpose.
    const orphanCycle = totalsOrder({
      paymentStatus: "succeeded",
      amountMinor: 5_000,
      mode: "subscription_cycle",
    });
    expect(summarizeOmsListTotals([orphanCycle]).paidSubscriptionCycleCount).toBe(1);
    // The list-order contract carries no subscription id at all, so the TS
    // summariser cannot apply the SQL filter even if it wanted to.
    expect("subscriptionId" in (orphanCycle as unknown as Record<string, unknown>)).toBe(false);
  });

  it("records that the TS totals aggregate the page while SQL aggregates the candidate set", () => {
    // SQL sums `candidate_orders` (the search/status-scoped set, then narrowed by
    // the paid_at window), NOT the page. summarizeOmsListTotals is handed only
    // the current page's orders, so on any multi-page queue the two figures
    // differ by construction.
    const paid = parsePaidSummary(migration);
    expect(paid.fromRelation).toBe("candidate_orders orders");
    expect(paid.windowPredicates).toEqual([
      "v_from IS NULL OR payment.paid_at >= v_from",
      "v_to IS NULL OR payment.paid_at <= v_to",
    ]);

    const page = [totalsOrder({ paymentStatus: "succeeded", amountMinor: 1_000 })];
    expect(summarizeOmsListTotals(page).orderCount).toBe(page.length);
  });
});

// --- migration parsing -------------------------------------------------

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function parseSummaryCounters(sql: string): { key: string; predicate: string }[] {
  const start = sql.indexOf("'summaryCounts',");
  const end = sql.indexOf("'summaryTotals',");
  if (start < 0 || end < 0 || end < start) throw new Error("no summaryCounts block parsed");
  const block = sql.slice(start, end);
  const counters = [
    ...block.matchAll(/'([A-Za-z]+)',\s*\(SELECT count\(\*\) FROM operational WHERE ([^)]+)\)/g),
  ].map((match) => ({ key: match[1], predicate: normalize(match[2]) }));
  if (counters.length === 0) throw new Error("no summaryCounts entries parsed");
  return counters;
}

function parsePaidSummary(sql: string): {
  amountMinorExpression: string;
  orderCountExpression: string;
  subscriptionFilter: string;
  paymentPredicate: string;
  fromRelation: string;
  windowPredicates: string[];
} {
  const start = sql.indexOf("paid_summary AS (");
  if (start < 0) throw new Error("no paid_summary CTE parsed");
  const block = sql.slice(start, sql.indexOf("SELECT jsonb_build_object", start));
  const grab = (pattern: RegExp, label: string): string => {
    const match = pattern.exec(block);
    if (!match) throw new Error(`no ${label} in paid_summary`);
    return normalize(match[1]);
  };
  return {
    amountMinorExpression: grab(/SELECT\s+([\s\S]*?)\s+AS amount_minor/, "amount_minor"),
    orderCountExpression: grab(/,\s*([^,]*?)\s+AS order_count/, "order_count"),
    subscriptionFilter: grab(/count\(\*\) FILTER \(\s*WHERE([\s\S]*?)\)::integer AS new_subscription_count/, "subscription filter"),
    paymentPredicate: grab(
      /JOIN latest_summary_payment[\s\S]*?WHERE\s+([\s\S]*?)\s+AND \(v_from/,
      "payment predicate",
    ),
    fromRelation: grab(/FROM\s+([\s\S]*?)\s+JOIN latest_summary_payment/, "paid_summary FROM"),
    windowPredicates: [...block.matchAll(/\(\s*(v_(?:from|to) IS NULL OR payment\.paid_at [<>]= v_(?:from|to))\s*\)/g)].map(
      (match) => normalize(match[1]),
    ),
  };
}

// --- fixtures ----------------------------------------------------------

/**
 * Every SQL counter bucket, at a DISTINCT multiplicity.
 *
 * One row per bucket would make all nine counters read 1, and a counter whose
 * predicate had been swapped for another bucket's would still match. Distinct
 * multiplicities mean any such swap changes the number.
 */
function counterFixture(): ListOrder[] {
  const buckets: [number, Parameters<typeof listOrder>[0]][] = [
    [1, { attentionReason: "active_hold", nextAction: "release_hold", activeHoldCount: 1 }],
    [2, { attentionReason: "payment_required", nextAction: "review_payment" }],
    [3, { attentionReason: "inventory_missing", nextAction: "review_inventory" }],
    [4, { attentionReason: "fulfillment_blocked", nextAction: "review_fulfillment" }],
    [5, { attentionReason: "fulfillment_exception", nextAction: "review_tracking" }],
    [6, { attentionReason: "fulfillment_pending", nextAction: "create_fulfillment" }],
    [7, { attentionReason: "invoice_missing", nextAction: "review_invoice" }],
    [8, { attentionReason: "none", nextAction: "none", providerOpsStatus: "omnipack_dispatched_not_picked" }],
    [1, { attentionReason: "none", nextAction: "none" }],
  ];
  return buckets.flatMap(([times, fields]) => Array.from({ length: times }, () => listOrder(fields)));
}

// The counters read four fields. Carrying only those keeps the fixture from
// asserting anything about the rest of the list contract.
function listOrder(fields: {
  attentionReason: string;
  nextAction: string;
  activeHoldCount?: number;
  providerOpsStatus?: string;
}): ListOrder {
  return {
    activeHoldCount: 0,
    providerOpsStatus: "none",
    ...fields,
  } as unknown as ListOrder;
}

function totalsOrder(fields: {
  paymentStatus: string;
  amountMinor: number;
  mode?: string;
}): ListOrder {
  const { amountMinor, mode = "one_time", paymentStatus } = fields;
  return { paymentStatus, mode, total: { amountMinor, currency: "PLN" } } as unknown as ListOrder;
}

/**
 * Mechanically translates one SQL counter predicate into the equivalent
 * predicate over a list order. Mechanical on purpose: a hand-written JS twin
 * would agree with SQL only until someone edited the SQL.
 */
function translateCounterPredicate(predicate: string): (order: ListOrder) => boolean {
  const field = (column: string): string => {
    const mapped: Record<string, string> = {
      attention_reason: "attentionReason",
      next_action: "nextAction",
      active_hold_count: "activeHoldCount",
      provider_ops_status: "providerOpsStatus",
    };
    const name = mapped[column];
    if (!name) throw new Error(`unmapped SQL counter column: ${column}`);
    return name;
  };
  const read = (order: ListOrder, column: string): unknown =>
    (order as unknown as Record<string, unknown>)[field(column)];

  let match = /^([a-z_]+) <> '([a-z_]+)'$/.exec(predicate);
  if (match) return (order) => read(order, match![1]) !== match![2];
  match = /^([a-z_]+) = '([a-z_]+)'$/.exec(predicate);
  if (match) return (order) => read(order, match![1]) === match![2];
  match = /^([a-z_]+) > (\d+)$/.exec(predicate);
  if (match) return (order) => Number(read(order, match![1])) > Number(match![2]);
  throw new Error(`unsupported SQL counter predicate: ${predicate}`);
}
