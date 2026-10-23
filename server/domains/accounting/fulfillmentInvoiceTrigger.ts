import { withAccountingInvoiceShadowTrigger as shadow, withAutoDispatchAccountingInvoiceTrigger as autoDispatch } from "@openlup/platform/invoicing";
import type { AccountingInvoiceIssuePort } from "../../../src/domains/accounting/ports.js";
import {
  decideChannelInvoice,
  type OrderInvoicePolicyReader,
} from "./channelInvoicePolicyGate.js";

// Structural mirror of the commerce OrderPaidFulfillmentPort, declared locally
// so the accounting domain does not import the commerce domain (the
// architecture guardrail forbids importing another domain's non-public
// internals). The composition root in api/cron passes the real commerce port,
// which is structurally compatible.
export type AutoDispatchFulfillmentResult =
  | { kind: "completed" | "skipped"; detail?: Record<string, unknown> }
  | { kind: "retryable" | "snooze" | "fatal"; reason: string }
  // A paid order routed to manual review (split shipment unsupported): no
  // handoff, so no accounting invoice is requested (readHandedOverFulfillmentOrderId
  // returns null). Mirrors OrderPaidFulfillmentResult so the commerce port stays
  // structurally assignable here.
  | { kind: "manual_review"; reason: string; detail?: Record<string, unknown> };

export interface AutoDispatchFulfillmentPort {
  ensureFulfilledFromPaidOrder(input: {
    orderUuid: string;
    outboxEventId: string;
    signal: AbortSignal;
  }): Promise<AutoDispatchFulfillmentResult>;
}

type FulfillmentHandoffRequest = {
  idempotencyKey: string;
  fulfillmentOrderId: string;
  actorUserId: string;
};

type FulfillmentHandoffPort<TResult = unknown> = {
  handOffCommerceFulfillmentOrder: (request: FulfillmentHandoffRequest) => Promise<TResult>;
};

export interface AccountingHandoffTriggerOptions {
  accountingPort: AccountingInvoiceIssuePort;
  providerKind?: string;
  failOnAccountingError?: boolean;
  issueTrigger?: "handoff" | "paid";
  // Wave B6. Absent everywhere this wave did not wire it, and an absent reader
  // decides `issue` — so every composition that predates it keeps today's
  // behaviour byte for byte.
  invoicePolicyReader?: OrderInvoicePolicyReader;
}

export function withAccountingInvoiceShadowTrigger<TResult, TPort extends FulfillmentHandoffPort<TResult>>(
  fulfillmentPort: TPort, options: AccountingHandoffTriggerOptions,
): TPort {
  return shadow(fulfillmentPort, packageOptions(options));
}
export function withAutoDispatchAccountingInvoiceTrigger(
  fulfillmentPort: AutoDispatchFulfillmentPort, options: AccountingHandoffTriggerOptions,
): AutoDispatchFulfillmentPort {
  return autoDispatch(fulfillmentPort, packageOptions(options));
}
function packageOptions(options: AccountingHandoffTriggerOptions) {
  return {
    ...options,
    providerKind: options.providerKind ?? "fakturownia",
    keys: {
      shadow: (key: string) => `${key}:accounting-invoice`,
      paid: (orderId: string) => `order-paid-dispatch:${orderId}:accounting-invoice-paid`,
      handoff: (orderId: string) => `order-paid-dispatch:${orderId}:accounting-invoice`,
    },
    invoicePolicyReader: options.invoicePolicyReader ? {
      readOrderInvoicePolicy: async (lookup: Parameters<OrderInvoicePolicyReader["readOrderInvoicePolicy"]>[0]) =>
        (await decideChannelInvoice(options.invoicePolicyReader, lookup)).action,
    } : undefined,
  };
}
