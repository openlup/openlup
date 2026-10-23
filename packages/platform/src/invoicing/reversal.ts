/** Donor reversal outcome/order semantics over host event adapters and writer.
 * @consumer api/_cron/accountingOrderReversalHandlers.ts
 */
export function createInvoiceReversalHandlers<Row, Request, Result extends { action: string; invoice: { status: string } | null }>(input: {
  enabled: boolean;
  events: readonly { eventType: string; adapt(row: Row): { kind: "ready"; request: Request } | { kind: "invalid_payload" } }[];
  request(request: Request): Promise<Result>;
}) {
  if (!input.enabled) return [];
  return input.events.map(event => ({
    eventType: event.eventType,
    timeoutMs: 10_000,
    async handle(row: Row): Promise<
      | { kind: "discard"; reason: string }
      | { kind: "processed"; detail: { accountingReversalAction: string; invoiceStatus: string } }
      | { kind: "retry"; reason: string }
    > {
      const compatibility = event.adapt(row);
      if (compatibility.kind === "invalid_payload") {
        return { kind: "discard", reason: "accounting_reversal_payload_invalid" };
      }
      try {
        const result = await input.request(compatibility.request);
        return {
          kind: "processed",
          detail: { accountingReversalAction: result.action, invoiceStatus: result.invoice?.status ?? "no_invoice" },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { kind: "retry", reason: message.slice(0, 300) };
      }
    },
  }));
}
