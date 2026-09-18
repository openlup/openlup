import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { AdminCommerceOrdersListResponse } from "./omsContracts.js";
import { summarizeOmsListTotals } from "./omsListTotals.js";
import {
  OMS_ATTENTION_PRIORITY_FALLBACK_RANK,
  OMS_ATTENTION_PRIORITY_LADDER,
  OMS_OPERATIONAL_LADDER,
  OMS_OPERATIONAL_LADDER_FALLBACK,
} from "./omsOperationalLadder.js";
import { summarizeOmsListOrders } from "./omsReadModelListSummary.js";

// The precedent for reading migration text from a test is
// src/lib/commerceOmsBoundary.test.ts. This is the LIVE body of
// public.commerce_oms_admin_list_queue - the one the admin queue request
// actually executes - not one of its superseded ancestors.
//
// ⛔ THIS PIN MUST MOVE WITH EVERY FULL-BODY REPLACE OF THE RPC. It was left on
// 20260816082705 by 20260903190000 and the suite stayed green, because that
// wave's body is byte-identical in the CASE arms this test parses. A stale pin
// does not fail - it silently stops covering the body that runs, which is the
// one failure mode this test exists to prevent. During the 20260903190000
// expand/contract window two identities are live; this pin names the 17-argument
// one, the one the BFF calls.
const LIVE_QUEUE_MIGRATION = "supabase/migrations/20260903190000_oms_queue_hides_withdrawn_checkout_rows.sql";
const migration = readFileSync(join(process.cwd(), LIVE_QUEUE_MIGRATION), "utf8");

type ListOrder = AdminCommerceOrdersListResponse["orders"][number];
type CaseArm = { predicate: string; value: string };

describe("OMS operational ladder parity with the live queue RPC", () => {
  it("mirrors the SQL attention ladder arm for arm, in order", () => {
    const sql = parseCaseArms(caseBody(migration, "attention_reason"));

    expect(sql.arms.map((arm) => arm.predicate)).toEqual(
      OMS_OPERATIONAL_LADDER.map((rung) => rung.sqlPredicate),
    );
    expect(sql.arms.map((arm) => arm.value)).toEqual(
      OMS_OPERATIONAL_LADDER.map((rung) => rung.attentionReason),
    );
    expect(sql.fallback).toBe(OMS_OPERATIONAL_LADDER_FALLBACK.attentionReason);
  });

  it("mirrors the SQL next-action ladder, including its collapsed accounting arm", () => {
    const sql = parseCaseArms(caseBody(migration, "next_action"));

    // The SQL next-action ladder is SHORTER than the attention ladder: the three
    // accounting rungs carry three attention reasons but one next action, so SQL
    // writes them as a single arm over the union of their literals. Asserting
    // that collapse is the point - an unremarked arm-count difference between
    // the two SQL ladders is exactly the kind of drift this test exists for.
    const collapsedFrom = OMS_OPERATIONAL_LADDER.length - (sql.arms.length - 1);
    expect(collapsedFrom).toBe(3);

    const oneToOne = OMS_OPERATIONAL_LADDER.slice(0, sql.arms.length - 1);
    expect(sql.arms.slice(0, -1).map((arm) => arm.predicate)).toEqual(
      oneToOne.map((rung) => rung.sqlPredicate),
    );
    expect(sql.arms.slice(0, -1).map((arm) => arm.value)).toEqual(oneToOne.map((rung) => rung.nextAction));

    const collapsedRungs = OMS_OPERATIONAL_LADDER.slice(-collapsedFrom);
    const collapsedArm: CaseArm = sql.arms[sql.arms.length - 1];
    expect([...new Set(collapsedRungs.map((rung) => rung.nextAction))]).toEqual([collapsedArm.value]);
    expect([...new Set(collapsedRungs.map((rung) => sqlColumn(rung.sqlPredicate)))]).toEqual([
      sqlColumn(collapsedArm.predicate),
    ]);
    expect(sqlLiterals(collapsedArm.predicate)).toEqual(
      [...new Set(collapsedRungs.flatMap((rung) => sqlLiterals(rung.sqlPredicate)))].sort(),
    );

    expect(sql.fallback).toBe(OMS_OPERATIONAL_LADDER_FALLBACK.nextAction);
  });

  it("mirrors the SQL attention_priority_desc rank arms, in order", () => {
    const priority = parsePriorityArms(migration);

    expect(priority.arms).toEqual(
      OMS_ATTENTION_PRIORITY_LADDER.map((entry) => ({
        attentionReason: entry.attentionReason,
        rank: entry.rank,
      })),
    );
    expect(priority.fallback).toBe(OMS_ATTENTION_PRIORITY_FALLBACK_RANK);
  });

  it("ranks every attention reason the ladder can emit", () => {
    const emitted = new Set(
      OMS_OPERATIONAL_LADDER.map((rung) => rung.attentionReason).filter((reason) => reason !== "none"),
    );
    const ranked = new Set(OMS_ATTENTION_PRIORITY_LADDER.map((entry) => entry.attentionReason));

    // An emitted reason with no rank silently sorts to the bottom of the
    // operator's attention queue (SQL ELSE 99) instead of failing loudly.
    expect([...emitted].filter((reason) => !ranked.has(reason))).toEqual([]);
  });
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

  // ---------------------------------------------------------------------
  // KNOWN LATENT DIVERGENCE (b) - `not_checked` inventory.
  // SQL `fulfillment_allowed` blocks anything not in ('reserved','consumed');
  // evaluateCommerceFulfillmentEligibility blocks only an explicit
  // missing/released/expired/review_required list, so `not_checked` is ALLOWED
  // there. Unreachable today because the `inventory_not_held` rung short-circuits
  // to inventory_missing before either fulfillment rung is consulted.
  // ---------------------------------------------------------------------
  it("records the fulfillment_allowed vs eligibility disagreement on not_checked inventory", () => {
    const allowed = fulfillmentAllowedArms(migration);
    expect(allowed).toContain("inventory.inventory_status NOT IN ('reserved', 'consumed')");

    const inventoryRung = OMS_OPERATIONAL_LADDER.find((rung) => rung.id === "inventory_not_held");
    const blockedRung = OMS_OPERATIONAL_LADDER.find((rung) => rung.id === "fulfillment_absent_and_blocked");
    expect(inventoryRung).toBeDefined();
    expect(blockedRung).toBeDefined();
    // The short-circuit is what keeps the disagreement latent: the inventory rung
    // must stay STRICTLY ABOVE the fulfillment-blocked rung. Reordering them
    // makes divergence (b) reachable, and turns this assertion red.
    expect(OMS_OPERATIONAL_LADDER.indexOf(inventoryRung!)).toBeLessThan(
      OMS_OPERATIONAL_LADDER.indexOf(blockedRung!),
    );

    // `not_checked` is not in ('reserved','consumed'), so the ladder stops at the
    // inventory rung on both sides and never asks fulfillment_allowed.
    expect(
      inventoryRung!.matches({
        orderStatus: "paid",
        activeHoldCount: 0,
        paymentStatus: "succeeded",
        hasShippingAddress: true,
        inventoryStatus: "not_checked",
        fulfillmentStatus: null,
        // TS eligibility would say ALLOWED for not_checked; SQL says blocked.
        fulfillmentAllowed: true,
        accountingStatus: "issued",
      } as Parameters<typeof inventoryRung.matches>[0]),
    ).toBe(true);
  });
});

// --- migration parsing -------------------------------------------------

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** The body of the `CASE ... END AS <alias>` expression, CASE/END excluded. */
function caseBody(sql: string, alias: string): string {
  const end = sql.indexOf(`END AS ${alias}`);
  if (end < 0) throw new Error(`no "END AS ${alias}" in ${LIVE_QUEUE_MIGRATION}`);
  const head = sql.slice(0, end);
  const start = head.lastIndexOf("CASE");
  if (start < 0) throw new Error(`no CASE opening "END AS ${alias}" in ${LIVE_QUEUE_MIGRATION}`);
  return head.slice(start + "CASE".length);
}

function parseCaseArms(body: string): { arms: CaseArm[]; fallback: string } {
  const arms = [...body.matchAll(/\bWHEN\b([\s\S]*?)\bTHEN\b\s*'([a-z_]+)'/g)].map((match) => ({
    predicate: normalize(match[1]),
    value: match[2],
  }));
  if (arms.length === 0) throw new Error("no WHEN ... THEN arms parsed");
  const fallback = /\bELSE\b\s*'([a-z_]+)'\s*$/.exec(body.trim());
  if (!fallback) throw new Error("no ELSE literal parsed");
  return { arms, fallback: fallback[1] };
}

function parsePriorityArms(sql: string): {
  arms: { attentionReason: string; rank: number }[];
  fallback: number;
} {
  const start = sql.indexOf("CASE attention_reason");
  if (start < 0) throw new Error(`no "CASE attention_reason" in ${LIVE_QUEUE_MIGRATION}`);
  const tail = sql.slice(start);
  const end = tail.indexOf("END");
  const body = tail.slice(0, end);
  const arms = [...body.matchAll(/WHEN\s+'([a-z_]+)'\s+THEN\s+(\d+)/g)].map((match) => ({
    attentionReason: match[1],
    rank: Number(match[2]),
  }));
  if (arms.length === 0) throw new Error("no priority arms parsed");
  const fallback = /\bELSE\s+(\d+)/.exec(body);
  if (!fallback) throw new Error("no priority ELSE rank parsed");
  return { arms, fallback: Number(fallback[1]) };
}

function sqlColumn(predicate: string): string {
  const match = /^([a-z_]+)\s/.exec(predicate);
  if (!match) throw new Error(`cannot read a column out of: ${predicate}`);
  return match[1];
}

function sqlLiterals(predicate: string): string[] {
  return [...predicate.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();
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

function fulfillmentAllowedArms(sql: string): string[] {
  return parseCaseArmsAllowingBooleans(caseBody(sql, "fulfillment_allowed")).map((arm) => arm.predicate);
}

function parseCaseArmsAllowingBooleans(body: string): { predicate: string }[] {
  return [...body.matchAll(/\bWHEN\b([\s\S]*?)\bTHEN\b\s*(?:'[a-z_]+'|true|false)/g)].map((match) => ({
    predicate: normalize(match[1]),
  }));
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
