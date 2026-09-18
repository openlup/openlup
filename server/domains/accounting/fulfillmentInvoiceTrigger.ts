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
  fulfillmentPort: TPort,
  options: AccountingHandoffTriggerOptions,
): TPort {
  return {
    ...fulfillmentPort,
    async handOffCommerceFulfillmentOrder(request: FulfillmentHandoffRequest) {
      const result = await fulfillmentPort.handOffCommerceFulfillmentOrder(request);
      try {
        // The operator hand-off reaches this wrapper holding only the
        // fulfillment order id, so the policy is read by that key.
        const decision = await decideChannelInvoice(options.invoicePolicyReader, {
          by: "fulfillmentOrder",
          fulfillmentOrderId: request.fulfillmentOrderId,
        });
        if (decision.issue) {
          await options.accountingPort.requestInvoiceIssueFromFulfillmentHandoff({
            idempotencyKey: `${request.idempotencyKey}:accounting-invoice`,
            fulfillmentOrderId: request.fulfillmentOrderId,
            providerKind: options.providerKind ?? "fakturownia",
          });
        }
      } catch (error) {
        if (options.failOnAccountingError) throw error;
      }
      return result;
    },
  } as TPort;
}

// Auto-dispatch sibling of withAccountingInvoiceShadowTrigger. The outbox
// commerce.order.paid -> fulfillment path drives handoff through the
// OrderPaidFulfillmentPort (ensureFulfilledFromPaidOrder), which issues the
// mark-handed-over RPC directly and therefore never reaches the admin
// hand-off wrapper above. Without this, an auto-dispatched paid order reaches
// handed_over but no accounting invoice is ever requested. Same semantics:
// idempotent (the issue RPC dedups on the order-derived invoice_ref, so any
// key is duplicate-safe) and fail-soft (accounting errors never fail the
// fulfillment dispatch — the outbox event still settles as processed).
export function withAutoDispatchAccountingInvoiceTrigger(
  fulfillmentPort: AutoDispatchFulfillmentPort,
  options: AccountingHandoffTriggerOptions,
): AutoDispatchFulfillmentPort {
  return {
    async ensureFulfilledFromPaidOrder(input) {
      // Both branches hold the order uuid, so both ask by the order key — the
      // strongest key available, and the one that needs no join.
      const lookup = { by: "order" as const, orderUuid: input.orderUuid };
      if (options.issueTrigger === "paid") {
        try {
          const decision = await decideChannelInvoice(options.invoicePolicyReader, lookup);
          if (decision.issue) {
            await options.accountingPort.requestInvoiceIssueFromPaidOrder({
              idempotencyKey: `order-paid-dispatch:${input.orderUuid}:accounting-invoice-paid`,
              orderId: input.orderUuid,
              providerKind: options.providerKind ?? "fakturownia",
            });
          }
        } catch (error) {
          if (options.failOnAccountingError) throw error;
        }
      }
      const result = await fulfillmentPort.ensureFulfilledFromPaidOrder(input);
      if (options.issueTrigger === "paid") return result;
      const fulfillmentOrderId = readHandedOverFulfillmentOrderId(result);
      if (fulfillmentOrderId) {
        try {
          const decision = await decideChannelInvoice(options.invoicePolicyReader, lookup);
          if (decision.issue) {
            await options.accountingPort.requestInvoiceIssueFromFulfillmentHandoff({
              idempotencyKey: `order-paid-dispatch:${input.orderUuid}:accounting-invoice`,
              fulfillmentOrderId,
              providerKind: options.providerKind ?? "fakturownia",
            });
          }
        } catch (error) {
          if (options.failOnAccountingError) throw error;
        }
      }
      return result;
    },
  };
}

function readHandedOverFulfillmentOrderId(result: AutoDispatchFulfillmentResult): string | null {
  if (result.kind !== "completed" && result.kind !== "skipped") return null;
  const id = result.detail?.fulfillmentOrderId;
  return typeof id === "string" ? id : null;
}
