import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";

const mock = vi.hoisted(() => ({ authorize: vi.fn(), service: vi.fn() }));
vi.mock("../../_lib/admin-domain/auth.js", () => ({
  readBearerToken: (req: HttpRequest) => req.headers.authorization?.replace(/^Bearer /, "") ?? null,
  createAdminAuthClient: vi.fn(() => ({})),
  authorizeCommerceAdminWithUser: mock.authorize,
}));
vi.mock("../../_lib/customer-domain/auth.js", () => ({ createCustomerServiceClient: mock.service }));

import { createReferenceOperatorHandler } from "./subscriptionOperator.js";

const ids = {
  order: "11111111-1111-4111-8111-111111111111",
  other: "22222222-2222-4222-8222-222222222222",
  client: "33333333-3333-4333-8333-333333333333",
  subscription: "44444444-4444-4444-8444-444444444444",
};
const env = { url: "http://127.0.0.1:54321", anonKey: "anon", serviceRoleKey: "service" };
function response() {
  const res = {
    status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: vi.fn(),
  } as unknown as HttpResponse;
  return res;
}
function request(orderId: unknown = ids.order, authorization?: string) {
  return { method: "GET", query: { orderId }, headers: authorization ? { authorization } : {} } as unknown as HttpRequest;
}
function fixture() {
  const reads: Array<{ table: string; filters: Record<string, unknown> }> = [];
  const rows: Record<string, Array<Record<string, unknown>>> = {
    commerce_orders: [
      { id: ids.order, client_id: ids.client, mode: "subscription_cycle", status: "paid", subscription_id: ids.subscription },
      { id: ids.other, client_id: ids.client, mode: "subscription_cycle", status: "failed", subscription_id: null },
    ],
    commerce_payments: [
      { order_id: ids.order, status: "succeeded" }, { order_id: ids.other, status: "failed" },
    ],
    subscriptions: [
      { id: ids.subscription, client_id: ids.client, status: "active", next_cycle_at: "2026-10-21T12:00:00Z" },
    ],
  };
  const client = { from(table: string) {
    const filters: Record<string, unknown> = {};
    const query = {
      select() { return query; },
      eq(column: string, value: unknown) { filters[column] = value; return query; },
      order() { return query; },
      async limit(count: number) {
        reads.push({ table, filters: { ...filters } });
        return { data: rows[table].filter((row) => Object.entries(filters).every(([key, value]) => row[key] === value)).slice(0, count), error: null };
      },
      async maybeSingle() {
        reads.push({ table, filters: { ...filters } });
        return { data: rows[table].find((row) => Object.entries(filters).every(([key, value]) => row[key] === value)) ?? null, error: null };
      },
    };
    return query;
  } };
  mock.service.mockReturnValue(client);
  return reads;
}

beforeEach(() => { vi.clearAllMocks(); });

describe("subscription reference operator readback", () => {
  it("refuses missing, customer, inactive, and machine sessions before service reads", async () => {
    const reads = fixture();
    const handler = createReferenceOperatorHandler(env);
    const anonymous = response();
    await handler(request(), anonymous);
    expect(anonymous.status).toHaveBeenCalledWith(401);
    expect(mock.authorize).not.toHaveBeenCalled();

    for (const denial of [
      { ok: false, code: "FORBIDDEN", message: "Admin role required" }, // customer or inactive membership
      { ok: true, userId: ids.client, role: "admin", isMachineActor: true },
    ]) {
      mock.authorize.mockResolvedValueOnce(denial);
      const res = response();
      await handler(request(ids.order, "Bearer genuine-token"), res);
      expect(res.status).toHaveBeenCalledWith(403);
    }
    expect(reads).toEqual([]);
  });

  it("requires one UUID and never offers a list or a caller-selected customer", async () => {
    const reads = fixture();
    mock.authorize.mockResolvedValue({ ok: true, userId: ids.client, role: "admin", isMachineActor: false });
    const handler = createReferenceOperatorHandler(env);
    for (const query of [{}, { orderId: ids.order, clientId: ids.client }, { orderId: [ids.order, ids.other] }]) {
      const res = response();
      await handler({ method: "GET", query, headers: { authorization: "Bearer genuine-token" } } as HttpRequest, res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(reads).toEqual([]);
  });

  it("returns only persisted status for the exact order and linked subscription", async () => {
    const reads = fixture();
    mock.authorize.mockResolvedValue({ ok: true, userId: ids.client, role: "admin", isMachineActor: false });
    const handler = createReferenceOperatorHandler(env);
    const res = response();
    await handler(request(ids.order, "Bearer genuine-token"), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: {
        order: { orderId: ids.order, status: "paid" },
        payment: { status: "succeeded" },
        subscription: { subscriptionId: ids.subscription, status: "active", nextRenewalAt: "2026-10-21T12:00:00Z" },
      },
    }));
    expect(reads).toEqual([
      { table: "commerce_orders", filters: { id: ids.order, mode: "subscription_cycle" } },
      { table: "commerce_payments", filters: { order_id: ids.order } },
      { table: "subscriptions", filters: { id: ids.subscription, client_id: ids.client } },
    ]);
    expect(JSON.stringify(vi.mocked(res.json).mock.calls[0])).not.toContain(ids.client);
    expect(JSON.stringify(vi.mocked(res.json).mock.calls[0])).not.toContain(ids.other);
  });

  it("reports a missing order without reading payment or subscription", async () => {
    const reads = fixture();
    mock.authorize.mockResolvedValue({ ok: true, userId: ids.client, role: "admin", isMachineActor: false });
    const res = response();
    await createReferenceOperatorHandler(env)(request("55555555-5555-4555-8555-555555555555", "Bearer genuine-token"), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(reads).toHaveLength(1);
  });
});
