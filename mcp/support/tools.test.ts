import { describe, expect, it, vi } from "vitest";

import { CLIENTS_PORTABLE_CONTRACT_VERSION } from "../../src/domains/clients/portableContracts.js";
import { COMMERCE_CONTRACT_VERSION } from "../../src/domains/commerce/types.js";
import { SUPPORT_CUSTOMER_360_CONTRACT_VERSION } from "../../src/domains/support/customer360Contracts.js";
import type { BffClient } from "../_core/bffClient.js";
import { buildSupportTools } from "./tools.js";

const tools = buildSupportTools();
const byName = new Map(tools.map((tool) => [tool.name, tool]));

describe("buildSupportTools", () => {
  it("exposes exactly the composed read-only support tools", () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "support__customer_diagnostics",
      "support__customer_journey_search",
      "support__customer_journey_snapshot",
      "support__explain_order_problem",
      "support__order_snapshot",
      "support__search",
    ]);
    for (const tool of tools) {
      expect(tool.call).toBeTypeOf("function");
      if (tool.name.startsWith("support__customer_journey_")) {
        expect(tool.contractVersion).toBe(SUPPORT_CUSTOMER_360_CONTRACT_VERSION);
      } else if (tool.name === "support__customer_diagnostics") {
        expect(tool.contractVersion).toBe("customer-diagnostic-history.v2");
      } else {
        expect(tool.contractVersion).toBeNull();
      }
      expect(tool.name).toMatch(/^[a-z]+__[a-z_]+$/);
    }
  });

  it("support__search fans out to clients search and OMS search with their own contract versions", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        candidates: [{
          subject: {
            subjectId: "subject-1", displayName: "Ada", email: "a@example.com", phone: null,
            lifecycleStage: "customer", createdAt: null, lastActivityAt: null,
          },
          matchedBy: "email", confidence: "exact", journeyLookup: { subjectId: "subject-1" },
          managedOverlay: { providerCustomerRef: "must-not-leak" },
        }],
      })
      .mockResolvedValueOnce({ orders: [{ orderId: "o1", orderNumber: "VP-1", status: "paid" }] });
    const bffClient = { get, post: vi.fn() } as unknown as BffClient;

    const result = await byName.get("support__search")?.call?.(
      { query: "a@example.com", pageSize: 3 },
      { bffClient },
    );

    expect(get).toHaveBeenNthCalledWith(
      1,
      "/api/bff/admin/clients/search",
      { query: "a@example.com", page: 0, pageSize: 3 },
      { contractVersion: CLIENTS_PORTABLE_CONTRACT_VERSION },
    );
    expect(get).toHaveBeenNthCalledWith(
      2,
      "/api/bff/admin/commerce/orders",
      { search: "a@example.com", page: 1, pageSize: 3 },
      { contractVersion: COMMERCE_CONTRACT_VERSION },
    );
    expect(result?.customers).toHaveLength(1);
    expect(result?.customers).toEqual([{
      subject: {
        subjectId: "subject-1", displayName: "Ada", email: "a@example.com", phone: null,
        lifecycleStage: "customer", createdAt: null, lastActivityAt: null,
      },
      matchedBy: "email", confidence: "exact", journeyLookup: { subjectId: "subject-1" },
    }]);
    expect(result?.orders).toHaveLength(1);
  });

  it("support__customer_journey_search calls the governed support BFF route in search mode", async () => {
    const get = vi.fn().mockResolvedValue({
      contractVersion: SUPPORT_CUSTOMER_360_CONTRACT_VERSION,
      query: "bartek@example.com",
      candidates: [],
      warnings: [],
    });
    const bffClient = { get, post: vi.fn() } as unknown as BffClient;

    await byName.get("support__customer_journey_search")?.call?.(
      { email: "bartek@example.com", pageSize: 5 },
      { bffClient },
    );

    expect(get).toHaveBeenCalledWith(
      "/api/bff/admin/support/customer-journey",
      {
        query: undefined,
        subjectId: undefined,
        orderId: undefined,
        subscriptionId: undefined,
        email: "bartek@example.com",
        pageSize: "5",
        mode: "search",
      },
      { contractVersion: SUPPORT_CUSTOMER_360_CONTRACT_VERSION },
    );
  });

  it("support__customer_journey_snapshot calls the governed support BFF route and preserves core evidence blocks", async () => {
    const get = vi.fn().mockResolvedValue({
      contractVersion: SUPPORT_CUSTOMER_360_CONTRACT_VERSION,
      lookup: { query: "subject-1", matchedBy: "subject_id", confidence: "exact",
        warnings: ["evidence_unavailable:subscription_cycles", "evidence_window_limited:checkout_outbox"] },
      orders: [], subscriptions: [], dunningCases: [], recovery: [],
      auditTrail: [{ eventId: "email-1", occurredAt: "2026-09-12T10:00:00.000Z",
        action: "communication.failed", outcome: "failed", entity: { kind: "order", id: "order-1" } }],
    });
    const bffClient = { get, post: vi.fn() } as unknown as BffClient;

    const result = await byName.get("support__customer_journey_snapshot")?.call?.(
      { orderId: "11111111-1111-4111-8111-111111111111" },
      { bffClient },
    );

    expect(get).toHaveBeenCalledWith(
      "/api/bff/admin/support/customer-journey",
      {
        query: undefined,
        subjectId: undefined,
        orderId: "11111111-1111-4111-8111-111111111111",
        subscriptionId: undefined,
        email: undefined,
        pageSize: "10",
      },
      { contractVersion: SUPPORT_CUSTOMER_360_CONTRACT_VERSION },
    );
    expect(result).toMatchObject({ orders: [], subscriptions: [], dunningCases: [], recovery: [],
      lookup: { warnings: ["evidence_unavailable:subscription_cycles", "evidence_window_limited:checkout_outbox"] },
      auditTrail: [expect.objectContaining({ eventId: "email-1", outcome: "failed" })],
    });
  });

  it("maps the neutral subjectId without legacy provider or client identifiers", async () => {
    const get = vi.fn().mockResolvedValue({ contractVersion: SUPPORT_CUSTOMER_360_CONTRACT_VERSION });
    const bffClient = { get, post: vi.fn() } as unknown as BffClient;

    await byName.get("support__customer_journey_snapshot")?.call?.(
      { subjectId: "subject-1" }, { bffClient },
    );

    expect(get).toHaveBeenCalledWith(
      "/api/bff/admin/support/customer-journey",
      expect.objectContaining({ subjectId: "subject-1" }),
      { contractVersion: SUPPORT_CUSTOMER_360_CONTRACT_VERSION },
    );
    expect(get.mock.calls[0]?.[1]).not.toHaveProperty("clientId");
  });

  it("does not return provider references from compact order evidence", async () => {
    const get = vi.fn().mockResolvedValue({ order: {
      payment: { status: "failed", providerPaymentId: "provider-payment-1" },
      paymentAttempts: [{ id: "attempt-1", status: "failed", provider: "private-provider" }],
      fulfillment: { status: "pending", trackingReferences: [{ providerKind: "private-provider", trackingUrl: "/private/path" }] },
      accounting: { status: "pending", providerInvoiceNumber: "private-invoice" },
    } });
    const bffClient = { get, post: vi.fn() } as unknown as BffClient;
    const result = await byName.get("support__order_snapshot")?.call?.(
      { orderId: "11111111-1111-4111-8111-111111111111" }, { bffClient },
    );

    expect(JSON.stringify(result)).not.toMatch(/provider|private\/path/i);
  });
});


describe("documented customer investigation inputs", () => {
  it.each(["orderNumber", "trackingNumber", "clientId"])("does not silently accept obsolete %s lookup fields", (key) => {
    const schema = byName.get("support__customer_journey_snapshot")!.requestSchema;
    expect(schema.safeParse({ subjectId: "subject-1", [key]: "legacy-value" }).success).toBe(false);
  });
});


describe("customer diagnostic MCP boundary", () => {
  it("advertises an SDK-compatible object root while preserving the strict command union", () => {
    const tool = byName.get("support__customer_diagnostics")!;
    expect(tool.inputSchema).toMatchObject({ type: "object", oneOf: expect.any(Array) });
    expect(tool.requestSchema.safeParse({
      mode: "search",
      from: "2026-09-10T00:00:00Z",
      to: "2026-09-11T00:00:00Z",
      segmentId: "11111111-1111-4111-8111-111111111111",
    }).success).toBe(false);
    expect(tool.requestSchema.safeParse({
      mode: "history",
      segmentId: "11111111-1111-4111-8111-111111111111",
      from: "2026-09-10T00:00:00Z",
    }).success).toBe(false);
    expect(tool.requestSchema.safeParse({
      mode: "overview",
      from: "2026-09-10T00:00:00Z",
      to: "2026-09-11T00:00:00Z",
      action: "account_refresh",
    }).success).toBe(false);
  });

  it("makes one bounded, read-only request without free-text or credential fields", async () => {
    const get = vi.fn().mockResolvedValue({ segments: [], groups: [] });
    const post = vi.fn();
    const tool = byName.get("support__customer_diagnostics")!;
    const input = { mode: "search", from: "2026-09-10T00:00:00Z", to: "2026-09-11T00:00:00Z", code: "refresh_failed" };
    await tool.call!(input, { bffClient: { get, post } as unknown as BffClient });
    expect(get).toHaveBeenCalledWith("/api/bff/admin/support/customer-diagnostics", { ...input, pageSize: "10" }, { contractVersion: "customer-diagnostic-history.v2" });
    expect(post).not.toHaveBeenCalled();
    await expect(tool.call!({ ...input, segmentCredential: "private" }, { bffClient: { get, post } as unknown as BffClient })).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("uses the same read-only tool for a bounded global overview", async () => {
    const get = vi.fn().mockResolvedValue({ groups: [] });
    const tool = byName.get("support__customer_diagnostics")!;
    const input = { mode: "overview", from: "2026-09-10T00:00:00Z", to: "2026-09-11T00:00:00Z", pageSize: 5, cursor: "10" };
    await tool.call!(input, { bffClient: { get } as unknown as BffClient });
    expect(get).toHaveBeenCalledWith("/api/bff/admin/support/customer-diagnostics", {
      ...input, pageSize: "5",
    }, { contractVersion: "customer-diagnostic-history.v2" });
  });
  it("propagates unavailable audit without inventing an empty successful history", async () => {
    const get = vi.fn().mockRejectedValue(new Error("audit_unavailable"));
    const tool = byName.get("support__customer_diagnostics")!;
    await expect(tool.call!({ mode: "history", segmentId: "11111111-1111-4111-8111-111111111111" }, { bffClient: { get } as unknown as BffClient })).rejects.toThrow("audit_unavailable");
  });
});
