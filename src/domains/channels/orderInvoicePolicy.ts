// Pure sales-document policy for orders by sales source. Sibling of
// orderCommsPolicy.ts, consumed by the accounting issue-request gate (wave B6):
// a channel that issues its own sales document must not also receive one from
// this deployment, and a channel that suppresses the document entirely must not
// have one minted for it.
//
// The gate MUST sit at the issue-REQUEST producer rather than inside the invoice
// RPCs. `accounting_invoice_issue_request_from_paid_order` and its handoff
// sibling dedupe on an order-derived invoice_ref, so a request that reaches them
// has already claimed the document; refusing there would turn a policy decision
// into a persistence error that the outbox would retry forever.

import type { InvoicePolicy } from "./contracts.js";

export interface OrderInvoicePolicy {
  sourceKind: string;
  invoicePolicy: string;
}

/** The decision, in the channels domain's own closed vocabulary. */
export type ChannelInvoiceAction = InvoicePolicy;

const KNOWN_ACTIONS: ReadonlySet<string> = new Set<InvoicePolicy>([
  "issue",
  "suppress",
  "channel_issues",
]);

/**
 * What this deployment should do about the sales document for an order.
 *
 * `null` means the order names no channel — a storefront order, or an order
 * that predates the source axis. Those issue exactly as they always have.
 *
 * An UNRECOGNISED stored value also resolves to `issue`. A sales document is a
 * legal artifact, so failing open to the behaviour this deployment has always
 * had is the only safe reading of a value this build does not know; the CHECK
 * constraint on `sales_channels.invoice_policy` is what keeps that branch
 * unreachable in practice rather than this function pretending it cannot happen.
 */
export function resolveOrderInvoiceAction(
  policy: OrderInvoicePolicy | null,
): ChannelInvoiceAction {
  if (policy === null) return "issue";
  return KNOWN_ACTIONS.has(policy.invoicePolicy)
    ? (policy.invoicePolicy as ChannelInvoiceAction)
    : "issue";
}

/** True when this deployment mints the sales document itself. */
export function platformIssuesInvoice(policy: OrderInvoicePolicy | null): boolean {
  return resolveOrderInvoiceAction(policy) === "issue";
}
