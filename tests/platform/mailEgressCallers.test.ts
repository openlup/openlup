import { globSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createGuardedEmailTransport, type EmailTransport } from "@openlup/platform/communications";

// Discover the reference bindings by their responsibility, independently of the
// host's provider-directory name. Each responsibility has exactly one factory.
async function factory(file: string) {
  const paths = [...globSync(`server/adapters/*/${file}.ts`)];
  expect(paths).toHaveLength(1);
  const module = await import(resolve(paths[0]!));
  const factories = Object.entries(module).filter(([key, value]) => key.startsWith("create") && typeof value === "function");
  expect(factories).toHaveLength(1);
  return factories[0]![1] as (input: Record<string, unknown>) => Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
}

type Effect = { operation: string; target: string; value?: unknown };
function store(effects: Effect[], telemetryThrows: boolean) {
  return {
    from(table: string) {
      effects.push({ operation: "from", target: table });
      const query = {
        select() { return query; }, eq() { return query; }, neq() { return query; },
        async maybeSingle() { return { data: null, error: null }; },
        async limit() { return { data: [], error: null }; },
        insert(row: unknown) {
          effects.push({ operation: "insert", target: table, value: row });
          if (telemetryThrows) throw new Error("synthetic telemetry failure");
          return query;
        },
        update(row: unknown) { effects.push({ operation: "update", target: table, value: row }); return query; },
        delete() { effects.push({ operation: "delete", target: table }); return query; },
      };
      return query;
    },
    async rpc(name: string, params: unknown) {
      effects.push({ operation: "rpc", target: name, value: params });
      if (telemetryThrows && name === "subscription_dunning_record_email_attempt") throw new Error("synthetic telemetry failure");
      return { data: "timeline-1", error: null };
    },
  };
}
const notice = { to: "reader@example.invalid", firstName: null, amountLabel: null, cause: "unknown", recoveryUrl: null,
  templateSlug: "subscription-payment-expired", notificationId: "notice-1", locale: "en", signal: new AbortController().signal };
afterEach(() => vi.restoreAllMocks());

it.each(["transactionalEmailPort", "subscriptionDunningEmailPort", "marketingEmailPort", "accountingInvoiceDeliveryPort"])(
  "%s refuses raw injection before any sender effect", async (name) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const effects: Effect[] = [];
    const send = vi.fn(async () => { effects.push({ operation: "send", target: "raw" }); throw new Error("must not send"); });
    const port = (await factory(name))({ client: store(effects, false), transport: { providerKind: "in-memory", send },
      apiKey: "", fromEmail: "sender@example.invalid", baseUrl: "https://portal.example.invalid" });
    if (name === "transactionalEmailPort") await port.sendOrderConfirmation!({ ...notice, orderId: "order-1", outboxEventId: "outbox-1", items: [], totals: null });
    if (name === "subscriptionDunningEmailPort") await port.sendPaymentExpired!(notice);
    if (name === "marketingEmailPort") await port.send!({ ...notice, subject: "Notice", html: "<p>Notice</p>", text: "Notice", outboxEventId: "outbox-1" });
    if (name === "accountingInvoiceDeliveryPort") await port.sendInvoiceDocument!({ recipientEmail: notice.to, clientId: "client-1", orderId: "order-1", outboxId: "outbox-1",
      invoiceId: "invoice-1", orderRef: "ORDER-1", invoiceRef: "INVOICE-1", providerInvoiceId: "provider-1", deliverySource: "invoice_issued", idempotencyKey: "invoice:key",
      document: { filename: "invoice.pdf", content: Buffer.from("%PDF-1.4") } });
    expect(send).not.toHaveBeenCalled();
    expect(effects.filter((e) => e.operation === "insert").every((e) => e.target === "email_sends")).toBe(true);
    expect(effects.filter((e) => e.operation === "rpc").map((e) => e.target)).toEqual(
      name === "accountingInvoiceDeliveryPort" ? ["communication_record_email_delivery"] : name === "subscriptionDunningEmailPort"
        ? ["communication_record_email_delivery", "subscription_dunning_record_email_attempt", "communication_record_email_delivery"]
        : ["communication_record_email_delivery", "communication_record_email_delivery"]);
    expect(effects.every((e) => ["from", "insert", "rpc"].includes(e.operation))).toBe(true);
    expect(effects.filter((e) => e.operation === "from").every((e) => ["comms_notification_controls", "email_sends"].includes(e.target))).toBe(true);
  },
);

it.each(["refusal", "drop", "failure", "abort", "throw", "telemetry"])(
  "W3 complete subscription-mail effect transcript: %s", async (scenario) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const effects: Effect[] = [];
    const send = vi.fn(async () => {
      effects.push({ operation: "send", target: "admitted" });
      if (scenario === "throw") throw new Error("synthetic sender failure");
      return { outcome: { ok: false, resendId: null, httpStatus: 0, providerError: "synthetic_failure", aborted: scenario === "abort" }, providerResponse: {} };
    });
    const transport: EmailTransport = createGuardedEmailTransport({ providerKind: "synthetic", send,
      policy: (intendedRecipient) => scenario === "refusal" ? { mode: "unknown" } as never : scenario === "drop"
        ? { mode: "drop", reason: "test_drop" }
        : { mode: "sandbox_sink", reason: "test_sink", intendedRecipient, recipient: "sink@example.invalid", credential: "synthetic", environmentTag: "non_production" },
    });
    const port = (await factory("subscriptionDunningEmailPort"))({ client: store(effects, scenario === "telemetry"), transport, apiKey: "", fromEmail: "sender@example.invalid" });
    const result = port.sendPaymentExpired!(notice);
    if (scenario === "throw") await expect(result).rejects.toThrow("synthetic sender failure");
    else await result;
    const compact = effects.map((e) => `${e.operation}:${e.target}`);
    const controlReads = compact.filter((e) => e === "from:comms_notification_controls");
    expect(controlReads.length).toBeGreaterThan(0);
    expect(compact).toEqual([
      ...controlReads, "rpc:communication_record_email_delivery",
      ...(["refusal", "drop"].includes(scenario) ? [] : ["send:admitted"]),
      ...(scenario === "throw" ? [] : ["rpc:subscription_dunning_record_email_attempt", "rpc:communication_record_email_delivery"]),
    ]);
    for (const e of effects.filter((entry) => entry.operation === "rpc")) {
      expect(e.value).toMatchObject(e.target === "subscription_dunning_record_email_attempt"
        ? { p_notification_id: "notice-1", p_sent_at: null }
        : { p_aggregate_type: "subscription_dunning_notification", p_aggregate_id: "notice-1" });
    }
    for (const e of effects.filter((entry) => entry.operation === "insert")) expect(e.value).toMatchObject({ sent_at: null });
  },
);
