import { describe, expect, it, vi } from "vitest";
import { createReferenceJourneyCustomerReadbackHandler, createReferenceJourneyOperatorReadbackHandler } from "../../server/domains/commerce/referenceJourneyReadbackHandlers.js";
import type { ReferenceJourneyOrderReadbackPort } from "../../src/domains/commerce/referenceJourneyReadbackContracts.js";
import type { HttpRequest, HttpResponse } from "../../server/_lib/types/http.js";
import { runReferenceJourneyReadbacks, type ReferenceJourneyReadbackConfiguration } from "./reference-journey-readbacks.js";

const ORDER = "22222222-2222-4222-8222-222222222222";
const OTHER_ORDER = "33333333-3333-4333-8333-333333333333";
const CUSTOMER_ROUTE = "/api/bff/reference-journey/customer/order-readback";
const OPERATOR_ROUTE = "/api/bff/reference-journey/operator/order-readback";
const config: ReferenceJourneyReadbackConfiguration = {
  baseUrl: "http://127.0.0.1:43123",
  customerToken: "synthetic-owner-token",
  crossCustomerToken: "synthetic-cross-token",
  operatorToken: "synthetic-operator-token",
  orderId: ORDER,
};

type CapturedCall = { route: string; operation: string | null; orderId: string | null; authorization: string | null };
type Mutation = (call: number, response: { status: number; body: unknown }) => { status: number; body: unknown };

// Executes the shipped handlers, with only auth/data ports and the HTTP host replaced.
// This witnesses transport and handler behavior; it does not activate BFF routes or prove live RLS.
function handlerBridge(mutate?: Mutation) {
  const calls: CapturedCall[] = [];
  const claims: unknown[] = [];
  const port: ReferenceJourneyOrderReadbackPort = {
    listCustomerOrders: vi.fn(async (_client, userId) => userId === "owner" ? [{ orderId: ORDER }] : null),
    getCustomerOrder: vi.fn(async (_client, userId, orderId) => userId === "owner" && orderId === ORDER ? { orderId: ORDER } : null),
    listOperatorOrders: vi.fn(async () => [{ orderId: ORDER, clientId: "synthetic-client" }]),
    getOperatorOrder: vi.fn(async (_client, orderId) => orderId === ORDER ? { orderId: ORDER, clientId: "synthetic-client" } : null),
  };
  const transport = vi.fn(async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push({ route: url.pathname, operation: url.searchParams.get("operation"), orderId: url.searchParams.get("orderId"), authorization });
    expect(url.origin).toBe(config.baseUrl);
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    expect(new Headers(init?.headers).get("accept")).toBe("application/json");
    const req = { method: init?.method, query: Object.fromEntries(url.searchParams), headers: Object.fromEntries(new Headers(init?.headers)) } as HttpRequest;
    const output = { status: 0, body: undefined as unknown };
    const res = {
      setHeader: vi.fn(),
      status: (status: number) => { output.status = status; return res; },
      json: (body: unknown) => { output.body = body; return res; },
    } as unknown as HttpResponse;
    if (url.pathname === CUSTOMER_ROUTE) {
      await createReferenceJourneyCustomerReadbackHandler({
        authorize: async () => authorization === `Bearer ${config.customerToken}` || authorization === `Bearer ${config.crossCustomerToken}`
          ? { ok: true, userId: authorization === `Bearer ${config.customerToken}` ? "owner" : "cross-user", accessToken: authorization.slice(7) }
          : { ok: false, code: "UNAUTHORIZED", message: "Customer session required" },
        actorPort: (token) => ({ asActor: async (actor, work) => { claims.push({ token, actor }); return work({}); } }),
        readback: port,
      })(req, res);
    } else if (url.pathname === OPERATOR_ROUTE) {
      await createReferenceJourneyOperatorReadbackHandler({
        authorize: async () => authorization === `Bearer ${config.operatorToken}`
          ? { ok: true, userId: "operator", isMachineActor: false }
          : { ok: false, code: "UNAUTHORIZED", message: "Operator session required" },
        servicePort: () => ({ asService: async (work) => work({}) }),
        governance: () => ({ flagEnabled: false, auditClient: { rpc: vi.fn() } }),
        readback: port,
      })(req, res);
    } else throw new Error("Unexpected transport route");
    const final = mutate ? mutate(calls.length, output) : output;
    return Response.json(final.body, { status: final.status });
  });
  return { transport: transport as typeof fetch, calls, claims, port };
}

describe("reference journey readback transport", () => {
  it("executes the eight neutral-route calls in order and proves content and denials through shipped handlers", async () => {
    const bridge = handlerBridge();
    const evidence = await runReferenceJourneyReadbacks(config, bridge.transport);
    const version = "reference.order-readback.v1";
    expect(evidence).toEqual({
      customerList: { contractVersion: version, orders: [{ orderId: ORDER }] },
      customerDetail: { contractVersion: version, order: { orderId: ORDER } },
      operatorList: { contractVersion: version, orders: [{ orderId: ORDER }] },
      operatorDetail: { contractVersion: version, order: { orderId: ORDER } },
      readbackDenials: { anonymousCustomer: 401, crossList: 403, crossDetail: 404, anonymousOms: 401 },
    });
    expect(bridge.calls).toEqual([
      { route: CUSTOMER_ROUTE, operation: "list", orderId: null, authorization: `Bearer ${config.customerToken}` },
      { route: CUSTOMER_ROUTE, operation: "detail", orderId: ORDER, authorization: `Bearer ${config.customerToken}` },
      { route: CUSTOMER_ROUTE, operation: "list", orderId: null, authorization: null },
      { route: CUSTOMER_ROUTE, operation: "list", orderId: null, authorization: `Bearer ${config.crossCustomerToken}` },
      { route: CUSTOMER_ROUTE, operation: "detail", orderId: ORDER, authorization: `Bearer ${config.crossCustomerToken}` },
      { route: OPERATOR_ROUTE, operation: "list", orderId: null, authorization: `Bearer ${config.operatorToken}` },
      { route: OPERATOR_ROUTE, operation: "detail", orderId: ORDER, authorization: `Bearer ${config.operatorToken}` },
      { route: OPERATOR_ROUTE, operation: "list", orderId: null, authorization: null },
    ]);
    expect(bridge.claims).toEqual([
      { token: config.customerToken, actor: { sub: "owner", role: "authenticated" } },
      { token: config.customerToken, actor: { sub: "owner", role: "authenticated" } },
      { token: config.crossCustomerToken, actor: { sub: "cross-user", role: "authenticated" } },
      { token: config.crossCustomerToken, actor: { sub: "cross-user", role: "authenticated" } },
    ]);
    expect(bridge.port.listCustomerOrders).toHaveBeenCalledTimes(2);
    expect(bridge.port.getCustomerOrder).toHaveBeenCalledTimes(2);
    expect(bridge.port.listOperatorOrders).toHaveBeenCalledOnce();
    expect(bridge.port.getOperatorOrder).toHaveBeenCalledOnce();
    for (const token of [config.customerToken, config.crossCustomerToken, config.operatorToken]) {
      expect(JSON.stringify(evidence)).not.toContain(token);
      expect(bridge.calls.every((call) => !call.route.includes(token))).toBe(true);
    }
  });

  it.each([1, 2, 6, 7])("refuses incorrect successful content at call %s", async (call) => {
    const bridge = handlerBridge((index, response) => index !== call ? response : {
      status: 200,
      body: { ok: true, data: { contractVersion: "reference.order-readback.v1", ...(call === 1 || call === 6 ? { orders: [{ orderId: OTHER_ORDER }] } : { order: { orderId: OTHER_ORDER } }) } },
    });
    await expect(runReferenceJourneyReadbacks(config, bridge.transport)).rejects.toThrow(/expected order/);
    expect(bridge.calls).toHaveLength(call);
  });

  it.each([3, 4, 5, 8])("refuses a negative control which succeeds at call %s", async (call) => {
    const bridge = handlerBridge((index, response) => index !== call ? response : { status: 200, body: { ok: true, data: {} } });
    await expect(runReferenceJourneyReadbacks(config, bridge.transport)).rejects.toThrow("negative control failed");
    expect(bridge.calls).toHaveLength(call);
  });

  it("rejects a status-only denial and an invalid response contract", async () => {
    const wrongCode = handlerBridge((index, response) => index === 4 ? { status: 403, body: { ok: false, error: { code: "NOT_FOUND" } } } : response);
    await expect(runReferenceJourneyReadbacks(config, wrongCode.transport)).rejects.toThrow("negative control failed");
    const wrongVersion = handlerBridge(() => ({ status: 200, body: { ok: true, data: { contractVersion: "unknown", orders: [{ orderId: ORDER }] } } }));
    await expect(runReferenceJourneyReadbacks(config, wrongVersion.transport)).rejects.toThrow("expected order");
  });

  it.each([
    undefined, {}, { baseUrl: undefined },
    ...["https://example.invalid", "http://localhost:43123", "http://127.0.0.1:43123/path", "http://127.0.0.1:43123?token=secret", "http://name:secret@127.0.0.1", "file:///tmp/proof", "invalid"].map((baseUrl) => ({ ...config, baseUrl })),
    ...["customerToken", "crossCustomerToken", "operatorToken"].flatMap((key) => [undefined, "", "spaces are invalid", "token\r\nheader"].map((value) => ({ ...config, [key]: value }))),
    { ...config, crossCustomerToken: config.customerToken }, { ...config, operatorToken: config.customerToken }, { ...config, orderId: "not-an-id" },
  ])("rejects missing/invalid configuration before any request (%#)", async (configuration) => {
    const transport = vi.fn();
    await expect(runReferenceJourneyReadbacks(configuration as ReferenceJourneyReadbackConfiguration, transport)).rejects.toThrow("Invalid reference journey readback configuration");
    expect(transport).not.toHaveBeenCalled();
  });

  it("redacts credentials from transport, JSON, and reflected response failures", async () => {
    const failures: Array<typeof fetch> = [
      vi.fn(async () => { throw new Error(config.customerToken); }),
      vi.fn(async () => new Response(config.crossCustomerToken, { status: 200 })),
      vi.fn(async () => Response.json({ ok: false, error: { code: "INTERNAL", message: config.operatorToken } }, { status: 500 })),
    ];
    for (const transport of failures) {
      let failure: unknown;
      try { await runReferenceJourneyReadbacks(config, transport); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      const rendered = String(failure) + (failure as Error).stack;
      for (const token of [config.customerToken, config.crossCustomerToken, config.operatorToken]) expect(rendered).not.toContain(token);
      expect((failure as Error).cause).toBeUndefined();
    }
  });

  it("refuses credential reflection even when the reflected value passes the order schema", async () => {
    const bridge = handlerBridge();
    const transport: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get("authorization") === `Bearer ${ORDER}`) headers.set("authorization", `Bearer ${config.customerToken}`);
      return bridge.transport(input, { ...init, headers });
    };
    await expect(runReferenceJourneyReadbacks({ ...config, customerToken: ORDER }, transport)).rejects.toThrow("evidence contains a credential");
  });
});
