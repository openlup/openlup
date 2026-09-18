import type {
  AdminOmsAttentionReason,
  AdminOmsNextAction,
  OmsAccountingStatus,
  OmsInventoryStatus,
  OmsOrderDetail,
  OmsPaymentStatus,
} from "./omsContracts.js";

/**
 * The operator attention/next-action ladder, declared once.
 *
 * The same ladder is implemented a second time in SQL, inside the live queue
 * RPC `public.commerce_oms_admin_list_queue`
 * (the live queue migration `20260903190000_oms_queue_hides_withdrawn_checkout_rows`,
 * the `operational` CTE and the `attention_priority_desc` rank arm). Both run on
 * the same admin request: SQL decides which orders are selected, what the
 * summary counters say and in what order the rows arrive; this module labels the
 * rows that come back. Nothing in the type system makes them agree.
 *
 * So the agreement is written down instead: every rung carries the live SQL
 * CASE-arm condition it mirrors, verbatim modulo whitespace, and
 * `omsOperationalLadder.test.ts` parses those arms out of the migration and
 * compares them rung for rung, in order. Editing one side without the other
 * turns that test red, which is the only thing standing between the two
 * implementations and a silent divergence.
 *
 * ⛔ Changing a rung here is a behaviour change to the OMS queue. It must be
 * made on both sides in the same change, or not at all.
 */

/** The facts the ladder reads. Flat on purpose: it is the join between the row
 * shapes this codebase carries and the columns the SQL `operational` CTE has. */
export interface OmsOperationalLadderInput {
  orderStatus: OmsOrderDetail["status"];
  activeHoldCount: number;
  paymentStatus: OmsPaymentStatus;
  hasShippingAddress: boolean;
  inventoryStatus: OmsInventoryStatus;
  fulfillmentStatus: OmsOrderDetail["fulfillmentStatus"];
  fulfillmentAllowed: boolean;
  accountingStatus: OmsAccountingStatus;
}

export interface OmsOperationalRung {
  /** Stable identity for this rung. Not emitted anywhere; it names the rung in
   * parity failures so a diff reads as "rung X moved", not "arm 7 changed". */
  readonly id: string;
  /** The live SQL `WHEN` condition, whitespace-normalised to single spaces. */
  readonly sqlPredicate: string;
  readonly attentionReason: AdminOmsAttentionReason;
  readonly nextAction: AdminOmsNextAction;
  readonly matches: (input: OmsOperationalLadderInput) => boolean;
}

export const OMS_OPERATIONAL_LADDER: readonly OmsOperationalRung[] = [
  {
    id: "terminal_order",
    sqlPredicate: "order_status IN ('refunded', 'cancelled')",
    attentionReason: "none",
    nextAction: "none",
    // A refunded/cancelled order is done, even though its payment_status is no
    // longer 'succeeded'. Without this rung the payment rung below would flag
    // every refunded order as needing payment review.
    matches: (input) => input.orderStatus === "refunded" || input.orderStatus === "cancelled",
  },
  {
    id: "active_hold",
    sqlPredicate: "active_hold_count > 0",
    attentionReason: "active_hold",
    nextAction: "release_hold",
    matches: (input) => input.activeHoldCount > 0,
  },
  {
    id: "payment_not_succeeded",
    sqlPredicate: "payment_status <> 'succeeded'",
    attentionReason: "payment_required",
    nextAction: "review_payment",
    matches: (input) => input.paymentStatus !== "succeeded",
  },
  {
    id: "missing_shipping_address",
    sqlPredicate:
      "EXISTS ( SELECT 1 FROM base_orders orders WHERE orders.id = derived.id AND orders.shipping_address_id IS NULL )",
    attentionReason: "missing_shipping_address",
    nextAction: "review_address",
    matches: (input) => !input.hasShippingAddress,
  },
  {
    id: "inventory_not_held",
    sqlPredicate: "inventory_status NOT IN ('reserved', 'consumed')",
    attentionReason: "inventory_missing",
    nextAction: "review_inventory",
    matches: (input) => input.inventoryStatus !== "reserved" && input.inventoryStatus !== "consumed",
  },
  {
    id: "fulfillment_absent_and_blocked",
    sqlPredicate: "fulfillment_status IS NULL AND fulfillment_allowed = false",
    attentionReason: "fulfillment_blocked",
    nextAction: "review_fulfillment",
    matches: (input) => !input.fulfillmentStatus && !input.fulfillmentAllowed,
  },
  {
    id: "fulfillment_absent",
    sqlPredicate: "fulfillment_status IS NULL",
    attentionReason: "fulfillment_pending",
    nextAction: "create_fulfillment",
    matches: (input) => !input.fulfillmentStatus,
  },
  {
    id: "fulfillment_before_label",
    sqlPredicate: "fulfillment_status IN ('created', 'packed', 'label_pending')",
    attentionReason: "fulfillment_pending",
    nextAction: "record_label",
    matches: (input) =>
      input.fulfillmentStatus === "created" ||
      input.fulfillmentStatus === "packed" ||
      input.fulfillmentStatus === "label_pending",
  },
  {
    id: "fulfillment_label_created",
    sqlPredicate: "fulfillment_status = 'label_created'",
    attentionReason: "fulfillment_pending",
    nextAction: "hand_off",
    matches: (input) => input.fulfillmentStatus === "label_created",
  },
  {
    id: "fulfillment_exception",
    sqlPredicate: "fulfillment_status = 'exception'",
    attentionReason: "fulfillment_exception",
    nextAction: "review_tracking",
    matches: (input) => input.fulfillmentStatus === "exception",
  },
  // The three accounting rungs carry three distinct attention reasons but one
  // shared next action. The SQL next-action ladder therefore collapses them into
  // a single arm over the union of their literals; the parity test asserts that
  // collapse explicitly rather than letting the arm counts differ unremarked.
  {
    id: "accounting_missing",
    sqlPredicate: "accounting_status = 'missing'",
    attentionReason: "invoice_missing",
    nextAction: "review_invoice",
    matches: (input) => input.accountingStatus === "missing",
  },
  {
    id: "accounting_blocked",
    sqlPredicate: "accounting_status = 'blocked'",
    attentionReason: "invoice_buyer_data_invalid",
    nextAction: "review_invoice",
    matches: (input) => input.accountingStatus === "blocked",
  },
  {
    id: "accounting_issue_failed",
    sqlPredicate: "accounting_status IN ('rejected', 'outbox_failed')",
    attentionReason: "invoice_issue_failed",
    nextAction: "review_invoice",
    matches: (input) => input.accountingStatus === "rejected" || input.accountingStatus === "outbox_failed",
  },
];

/** The `ELSE` of both SQL CASE expressions, and the fall-through of the loop. */
export const OMS_OPERATIONAL_LADDER_FALLBACK: {
  readonly attentionReason: AdminOmsAttentionReason;
  readonly nextAction: AdminOmsNextAction;
} = { attentionReason: "none", nextAction: "none" };

/**
 * The `attention_priority_desc` sort ranks, in SQL arm order. Lower sorts first.
 *
 * Nothing in TypeScript consumes this today - the queue arrives pre-sorted from
 * SQL, and the fixture bundle does not offer that sort. It is declared here
 * because the ranking is part of the same ladder: an attention reason added
 * above without a rank silently sorts to the bottom of the operator's queue.
 * The parity test binds it to the live migration arm for arm.
 */
export const OMS_ATTENTION_PRIORITY_LADDER: readonly {
  readonly attentionReason: AdminOmsAttentionReason;
  readonly rank: number;
}[] = [
  { attentionReason: "active_hold", rank: 1 },
  { attentionReason: "payment_required", rank: 2 },
  { attentionReason: "missing_shipping_address", rank: 3 },
  { attentionReason: "inventory_missing", rank: 4 },
  { attentionReason: "fulfillment_blocked", rank: 5 },
  { attentionReason: "fulfillment_exception", rank: 6 },
  { attentionReason: "invoice_issue_failed", rank: 7 },
  { attentionReason: "invoice_buyer_data_invalid", rank: 8 },
  { attentionReason: "invoice_missing", rank: 9 },
  // Deliberately the same rank as invoice_missing in the live body.
  { attentionReason: "fulfillment_pending", rank: 9 },
];

export const OMS_ATTENTION_PRIORITY_FALLBACK_RANK = 99;

/** Walks the ladder once and returns the first rung that matches. */
export function resolveOmsOperationalState(input: OmsOperationalLadderInput): {
  attentionReason: AdminOmsAttentionReason;
  nextAction: AdminOmsNextAction;
} {
  for (const rung of OMS_OPERATIONAL_LADDER) {
    if (rung.matches(input)) return { attentionReason: rung.attentionReason, nextAction: rung.nextAction };
  }
  return { ...OMS_OPERATIONAL_LADDER_FALLBACK };
}
