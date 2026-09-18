import type { SupabaseClient } from "@supabase/supabase-js";

export type CustomerFixtureSettlementSnapshot = {
  fulfillments: Array<{ status?: unknown }>;
  commands: Array<{ status?: unknown }>;
  dispatchRefs: Array<{ status?: unknown; provider_order_id?: unknown }>;
  outbox: Array<{ status?: unknown }>;
  invoices: Array<{ status?: unknown; email_status?: unknown }>;
  invoiceOutbox: Array<{ status?: unknown }>;
};

type SettlementRow = Record<string, unknown>;
type SettlementQuery = {
  eq(
    column: string,
    value: string,
  ): Promise<{
    data: SettlementRow[] | null;
    error: { message?: string } | null;
  }>;
};
type SettlementReader = {
  from(table: string): { select(columns: string): SettlementQuery };
};

const settledFulfillmentStatuses = new Set([
  "handed_over",
  "in_transit",
  "delivered",
  "cancelled",
]);
const settledCommandStatuses = new Set([
  "confirmed",
  "terminal_rejected",
  "cancelled",
]);
const settledRefStatuses = new Set(["failed", "cancelled"]);
const activeOutboxStatuses = new Set(["pending", "processing", "failed"]);
const settledInvoiceStatuses = new Set(["accepted", "issued"]);
const settledInvoiceEmailStatuses = new Set(["sent", "not_required"]);
const settledInvoiceOutboxStatuses = new Set(["succeeded", "cancelled"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function customerFixtureSettlementProblems(
  snapshot: CustomerFixtureSettlementSnapshot,
): string[] {
  const problems: string[] = [];
  if (snapshot.fulfillments.some(({ status }) => !settledFulfillmentStatuses.has(text(status))))
    problems.push("unsettled fulfillment");
  if (snapshot.commands.some(({ status }) => !settledCommandStatuses.has(text(status))))
    problems.push("active provider command");
  if (snapshot.dispatchRefs.some(({ status, provider_order_id }) =>
    !(text(status) === "created" && text(provider_order_id)) && !settledRefStatuses.has(text(status)),
  )) problems.push("unsettled dispatch ref");
  if (snapshot.outbox.some(({ status }) => activeOutboxStatuses.has(text(status))))
    problems.push("active outbox");
  if (snapshot.invoices.some(({ status, email_status }) =>
    !settledInvoiceStatuses.has(text(status)) || !settledInvoiceEmailStatuses.has(text(email_status)),
  )) problems.push("unsettled invoice");
  if (snapshot.invoiceOutbox.some(({ status }) => !settledInvoiceOutboxStatuses.has(text(status))))
    problems.push("active invoice outbox");
  return problems;
}

const DEFAULT_SETTLEMENT_ATTEMPTS = 8;

function settlementAttempts(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(String(env.CUSTOMER_ACCOUNT_SETTLEMENT_ATTEMPTS ?? ""), 10);
  if (!Number.isInteger(parsed)) return DEFAULT_SETTLEMENT_ATTEMPTS;
  return Math.max(1, parsed);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The every-minute shared dispatcher drains the fixture's payment-intent and
// fulfillment aggregates asynchronously, so a single read is a race, not a
// verdict: poll the same fixture-scoped snapshot until it settles.
export async function proveCustomerFixtureSettlement(
  service: SupabaseClient,
  orderId: string,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const attempts = settlementAttempts(env);
  let problems: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    problems = await readCustomerFixtureSettlementProblems(service, orderId);
    if (problems.length === 0) return;
    if (attempt < attempts) await sleep(attempt <= 2 ? 1500 : 3000);
  }
  throw new Error(`customer fixture settlement proof failed: ${problems.join(", ")}`);
}

async function readCustomerFixtureSettlementProblems(
  service: SupabaseClient,
  orderId: string,
): Promise<string[]> {
  const client = service as unknown as SettlementReader;
  const rows = async (table: string, column: string, value: string, columns: string) => {
    const { data, error } = await client.from(table).select(columns).eq(column, value);
    if (error)
      throw new Error(`customer fixture settlement read failed for ${table}: ${error.message}`);
    return Array.isArray(data) ? data : [];
  };
  const fulfillments = await rows("commerce_fulfillment_orders", "order_id", orderId, "id,status");
  const fulfillmentIds = fulfillments.map((row) => text(row.id)).filter(Boolean);
  const [commands, dispatchRefs, orderOutbox, invoices, paymentIntents] = await Promise.all([
    rows("commerce_fulfillment_provider_commands", "order_id", orderId, "status"),
    rows("omnipack_dispatch_refs", "order_id", orderId, "status,provider_order_id"),
    rows("outbox_events", "aggregate_id", orderId, "status"),
    rows("accounting_invoices", "order_id", orderId, "id,status,email_status"),
    rows("commerce_payment_intents", "order_id", orderId, "id"),
  ]);
  const paymentOutbox = (await Promise.all(
    paymentIntents.map((row) => rows("outbox_events", "aggregate_id", text(row.id), "status")),
  )).flat();
  const invoiceOutbox = (await Promise.all(invoices.flatMap((row) => [
    rows("accounting_invoice_issue_outbox", "invoice_id", text(row.id), "status"),
    rows("accounting_invoice_delivery_outbox", "invoice_id", text(row.id), "status"),
    rows("accounting_invoice_correction_outbox", "invoice_id", text(row.id), "status"),
  ]))).flat();
  const fulfillmentOutbox = (await Promise.all(
    fulfillmentIds.map((id) => rows("outbox_events", "aggregate_id", id, "status")),
  )).flat();
  return customerFixtureSettlementProblems({
    fulfillments,
    commands,
    dispatchRefs,
    outbox: [...orderOutbox, ...paymentOutbox, ...fulfillmentOutbox],
    invoices,
    invoiceOutbox,
  });
}
