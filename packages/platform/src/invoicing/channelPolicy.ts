type ChannelInvoiceAction = "issue" | "channel_issues" | "suppress";

export type InvoicePolicyLookup =
  | { by: "order"; orderUuid: string }
  | { by: "fulfillmentOrder"; fulfillmentOrderId: string };

/** Reads the resolved sales-source invoice action for either producer key.
 * Read failures propagate to the caller.
 */
export interface OrderInvoicePolicyReader {
  readOrderInvoicePolicy(lookup: InvoicePolicyLookup): Promise<ChannelInvoiceAction>;
}

export interface ChannelInvoiceDecision {
  issue: boolean;
  action: ChannelInvoiceAction;
  detail: Record<string, unknown>;
}

const ISSUE: ChannelInvoiceDecision = { issue: true, action: "issue", detail: {} };

function refusal(action: ChannelInvoiceAction): ChannelInvoiceDecision {
  return {
    issue: false,
    action,
    detail: action === "channel_issues"
      // The far side mints the document. Stamped with the same key an order
      // metadata write would have used, so a later wave that gains a metadata
      // path moves the value rather than renaming it.
      ? { invoicePolicy: action, invoiceIssuedBy: "channel", accountingInvoiceSkipped: action }
      // The operator declared that no sales document is produced at all.
      : { invoicePolicy: action, accountingInvoiceSkipped: action },
  };
}

/**
 * Whether this deployment should request the sales document for an order.
 *
 * An ABSENT reader answers `issue`. Composition roots that predate this wave —
 * and every test that builds a producer without one — keep today's behaviour
 * exactly, which is what makes the storefront path provably unchanged.
 */
export async function decideChannelInvoice(
  reader: OrderInvoicePolicyReader | undefined,
  lookup: InvoicePolicyLookup,
): Promise<ChannelInvoiceDecision> {
  if (!reader) return ISSUE;
  const action = await reader.readOrderInvoicePolicy(lookup);
  return action === "issue" ? ISSUE : refusal(action);
}
