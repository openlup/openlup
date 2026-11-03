import ts from "typescript";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresCustomerOrderHistoryReadStore, createPostgresAccountReadSources,
  readPostgresCustomerAccountClient, createPostgresCustomerSubscriptionSnapshotPort,
  createPostgresCustomerNewsletterPreferencesPort,
  type NativeAccountSourcesOptions,
} from "../../src/account-support/index.js";

const scope = { principalId: "a1000000-0000-4000-8000-000000000001", clientId: "a1000000-0000-4000-8000-000000000002" };
const orderId = "a1000000-0000-4000-8000-000000000003";
const at = "2026-11-01T12:00:00.000Z";
const money = (amountMinor: number) => ({ amountMinor, currency: "EUR" });
const quote = { subtotalGross: money(1200), discountTotalGross: money(100), shippingGross: money(200),
  shippingDiscountGross: money(200), taxTotal: money(183), totalGross: money(1100),
  lines: [{ sku: "NEUTRAL-1", productSlug: "neutral", quantity: 2, unitPriceGross: money(600), lineSubtotalGross: money(1200),
    tax: { vatRateBps: 2000 } }] };
const order = { id: orderId, client_id: scope.clientId, currency_code: "EUR", total_amount_minor: "1100", metadata: { quoteSnapshot: { quote } } };

describe("native account persistence boundary", () => {
  it("checks native reader and actor declarations with TypeScript", () => {
    // Vitest erases type assertions; execute the checker on this actual owner-fit file.
    const file = fileURLToPath(import.meta.url);
    const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true,
      noEmit: true, esModuleInterop: true, allowImportingTsExtensions: true, types: ["node"] });
    const source = program.getSourceFile(file)!;
    const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
    expect(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: path => path,
      getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" })).toBe("");
  });
  it("translates captured money, bound parameters and line ordinals without current prices", async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: [{ row: sql.includes("item.line_ordinal")
      ? { id: "line", sku_id: "sku", quantity: 2, line_ordinal: 1, source_line_ordinal: 1, unit_amount_minor: "550", line_amount_minor: "1100", catalog_unit_amount_minor: "600", catalog_line_amount_minor: "1200", promotion_discount_allocated_minor: "100", catalog_sku: "NEUTRAL-1", currency_code: "EUR", total_amount_minor: "1100", metadata: order.metadata }
      : order }] }));
    const port = createPostgresCustomerOrderHistoryReadStore({ query }, { ...scope, readInvoiceSummaries: async () => new Map() });
    expect(await port.readCustomerOrder(scope.clientId, orderId)).toMatchObject({ currency: "EUR", subtotal_cents: 1200,
      discount_cents: 100, shipping_cents: 200, shipping_discount_cents: 200, tax_cents: 183, total_cents: 1100 });
    expect(await port.readOrderLines(orderId)).toMatchObject([{ quantity: 2, unit_price_cents: 600, total_cents: 1200,
      product_snapshot: { quoteLine: { sku: "NEUTRAL-1" } }, vat_rate_bps: 2000 }]);
    for (const [sql, values] of query.mock.calls) {
      expect(sql).toContain("c.principal_id=$1::uuid AND c.id=$2::uuid");
      expect(values).toEqual([scope.principalId, scope.clientId, orderId]);
      expect(sql).not.toContain(scope.principalId);
    }
    const calls = query.mock.calls.length;
    expect(await port.readCustomerOrder(orderId, orderId)).toBeNull();
    expect(query).toHaveBeenCalledTimes(calls);
  });
  it("uses source ordinals for promoted split lines and retains each effective allocation", async () => {
    const splitQuote = { ...quote, discountTotalGross: money(99), totalGross: money(1101), taxTotal: money(184) };
    const query = vi.fn(async () => ({ rows: [551, 550].map((effective, index) => ({ row: {
      id: `split-${index}`, sku_id: "sku", catalog_sku: "NEUTRAL-1", quantity: 1, line_ordinal: index + 1, source_line_ordinal: 1,
      unit_amount_minor: String(effective), line_amount_minor: String(effective), catalog_unit_amount_minor: "600",
      catalog_line_amount_minor: "600", promotion_discount_allocated_minor: String(600 - effective),
      currency_code: "EUR", total_amount_minor: "1101", metadata: { quoteSnapshot: { quote: splitQuote } },
    } })) }));
    const port = createPostgresCustomerOrderHistoryReadStore({ query }, { ...scope, readInvoiceSummaries: async () => new Map() });
    expect(await port.readOrderLines(orderId)).toMatchObject([
      { quantity: 1, total_cents: 600, discount_allocated_cents: 49, effective_total_cents: 551 },
      { quantity: 1, total_cents: 600, discount_allocated_cents: 50, effective_total_cents: 550 },
    ]);
  });
  it("keeps the existing aggregate diagnostic fallback when native split VAT rounds differently", async () => {
    const roundingQuote = { ...quote, subtotalGross: money(200), discountTotalGross: money(1),
      shippingGross: money(0), shippingDiscountGross: money(0), totalGross: money(199), taxTotal: money(34),
      lines: ["NEUTRAL-1", "NEUTRAL-2"].map(sku => ({ sku, quantity: 1, unitPriceGross: money(100),
        lineSubtotalGross: money(100), tax: { vatRateBps: 2000 } })) };
    const query = vi.fn(async () => ({ rows: [100, 99].map((effective, index) => ({ row: {
      id: `round-${index}`, sku_id: `sku-${index}`, quantity: 1, line_ordinal: index + 1, source_line_ordinal: index + 1,
      unit_amount_minor: String(effective), line_amount_minor: String(effective), catalog_unit_amount_minor: "100",
      catalog_line_amount_minor: "100", promotion_discount_allocated_minor: String(100 - effective),
      currency_code: "EUR", total_amount_minor: "199", metadata: { quoteSnapshot: { quote: roundingQuote } },
    } })) }));
    const port = createPostgresCustomerOrderHistoryReadStore({ query }, { ...scope, readInvoiceSummaries: async () => new Map() });
    expect(await port.readOrderLines(orderId)).toMatchObject([
      { effective_total_cents: 100, effective_net_cents: 83 }, { effective_total_cents: 99, effective_net_cents: 83 },
    ]);
  });
  it("keeps recorded legacy summary/line facts and refuses only detail without captured money", async () => {
    const query = vi.fn(async (): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: [{ row: { ...order, metadata: {} } }] }));
    const port = createPostgresCustomerOrderHistoryReadStore({ query }, { ...scope, readInvoiceSummaries: async () => new Map() });
    expect(await port.readCustomerOrders(scope.clientId, [], 20)).toMatchObject([{ currency: "EUR", total_cents: 1100 }]);
    expect((await port.readCustomerOrders(scope.clientId, [], 20))[0]).not.toHaveProperty("tax_cents");
    await expect(port.readCustomerOrder(scope.clientId, orderId)).rejects.toThrow("native_account_order_money_unavailable");
    query.mockResolvedValue({ rows: [{ row: { ...order, metadata: {}, unit_amount_minor: "550", line_amount_minor: "1100" } }] });
    expect(await port.readOrderLines(orderId)).toMatchObject([{ unit_price_cents: 550, total_cents: 1100 }]);
    expect((await port.readOrderLines(orderId))[0]).not.toHaveProperty("vat_rate_bps");
    query.mockResolvedValue({ rows: [{ row: { ...order, total_amount_minor: "999" } }] });
    await expect(port.readCustomerOrder(scope.clientId, orderId)).rejects.toThrow("native_account_order_money_mismatch");
  });
  it("checks companion ownership even when called directly and never sends foreign IDs to invoice owners", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] as Record<string, unknown>[] }));
    const invoices = vi.fn(async () => new Map());
    const port = createPostgresCustomerOrderHistoryReadStore({ query }, { ...scope, readInvoiceSummaries: invoices });
    expect(await port.readInvoiceSummaries([orderId])).toEqual(new Map());
    expect(invoices).not.toHaveBeenCalled();
    await port.readOrderLines(orderId);
    for (const operation of [port.readPaymentStatuses, port.readTracking,
      port.readFulfillmentOperations, port.readStatusEvidence, port.readActiveHoldOrderIds,
      port.readReleasedProviderExceptionHolds]) await operation([orderId]);
    for (const [sql] of query.mock.calls) expect(sql).toContain("owned_orders");
    await expect(port.readCustomerOrders(scope.clientId, [], 101)).rejects.toThrow("native_account_order_limit_invalid");
    expect(() => createPostgresCustomerOrderHistoryReadStore({ query }, { ...scope, principalId: "", readInvoiceSummaries: invoices }))
      .toThrow("native_account_scope_invalid");
  });
  it("does not let an injected profile reader bypass a mismatched principal/client binding", async () => {
    const readAddresses = vi.fn(async () => []);
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] as Record<string, unknown>[] }));
    const options = { ...scope, additional: { readAddresses } } as unknown as NativeAccountSourcesOptions<unknown, unknown>;
    const sources = createPostgresAccountReadSources({ query }, options);
    await expect(sources.readAddresses(scope.clientId)).rejects.toThrow("native_account_owner_mismatch");
    expect(readAddresses).not.toHaveBeenCalled();
    expect(await readPostgresCustomerAccountClient({ query }, scope)).toBeNull();
  });
  it("refuses exactly missing profile/event sections while composing owned native identity", async () => {
    const query = vi.fn(async () => ({ rows: [{ row: { id: scope.clientId, email: "owner@example.invalid" } }] }));
    const options = { ...scope, additional: { readExtension: async () => ({ note: "host" }), readNextCharges: async () => new Map() } } as unknown as NativeAccountSourcesOptions<unknown, unknown>;
    const sources = createPostgresAccountReadSources({ query }, options);
    for (const [read, section] of [[sources.readAddresses,"addresses"], [sources.readOrdererProfiles,"billingProfiles"],
      [sources.readPaymentPreferences,"paymentPreferences"], [sources.readDeliveryPreferences,"deliveryPreferences"],
      [sources.readEvents,"events"]] as const) {
      await expect(read(scope.clientId)).rejects.toMatchObject({ message: "host_binding_required", code: "host_binding_required", section });
    }
    expect(await sources.readExtension(scope.clientId)).toEqual({ note: "host" });
    expect(await readPostgresCustomerAccountClient({ query }, scope)).toMatchObject({ email: "owner@example.invalid" });
  });
  it("preserves SQL errors/nulls, validates responses and only exposes the available withdrawal write", async () => {
    const preferences = { contractVersion: "customer.communication_preferences.v1", contact: null,
      marketingNewsletter: { purpose: "marketing_newsletter", state: "denied", granted: false,
        source: null, reason: null, capturedAt: at, updatedAt: at } };
    const rpc = vi.fn(async () => ({ data: preferences as unknown, error: null as unknown }));
    const consent = createPostgresCustomerNewsletterPreferencesPort({ rpc });
    expect(await consent.withdrawNewsletter()).toEqual(preferences);
    expect(rpc).toHaveBeenLastCalledWith("customer_communication_preferences_set_as_actor", { p_marketing_newsletter_consent: false });
    expect(await consent.getPreferences()).toEqual(preferences);
    rpc.mockResolvedValue({ data: { ...preferences, marketingNewsletter: { ...preferences.marketingNewsletter,
      state: "granted", granted: true, source: "customer_communication_preferences" } }, error: null });
    await expect(consent.getPreferences()).rejects.toMatchObject({ code: "host_binding_required", section: "newsletterConsent" });
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await consent.getPreferences()).toBeNull();
    const snapshot = createPostgresCustomerSubscriptionSnapshotPort({ rpc });
    expect(await snapshot.getSnapshot()).toBeNull();
    const error = { code: "42501", message: "refused" };
    rpc.mockResolvedValue({ data: null, error });
    await expect(snapshot.getSnapshot()).rejects.toBe(error);
    rpc.mockResolvedValue({ data: {}, error: null });
    await expect(snapshot.getSnapshot()).rejects.toThrow();
    await expect(consent.getPreferences()).rejects.toThrow();
  });
});
