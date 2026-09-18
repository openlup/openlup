import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReferenceJourneyCustomerReadbackHandler, createReferenceJourneyOperatorReadbackHandler } from "./referenceJourneyReadbackHandlers.js";

const ORDER = "22222222-2222-4222-8222-222222222222";
const req = (query: Record<string, string> = {}, method = "GET") => ({ method, query, headers: {} }) as never;
function response() { const output: { status?: number; body?: unknown } = {}; const res = { setHeader: vi.fn(), status: vi.fn((status: number) => { output.status = status; return res; }), json: vi.fn((body: unknown) => { output.body = body; return res; }) }; return { res: res as never, output }; }
const port = { listCustomerOrders: vi.fn(async () => [{ orderId: ORDER }]), getCustomerOrder: vi.fn(async () => ({ orderId: ORDER })), listOperatorOrders: vi.fn(async () => [{ orderId: ORDER, clientId: "client-1" }]), getOperatorOrder: vi.fn(async () => ({ orderId: ORDER, clientId: "client-1" })) };

describe("reference journey readback handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects anonymous or malformed customer requests before it binds actor data", async () => {
    const actorPort = vi.fn();
    const authorize = vi.fn(async () => ({ ok: false as const, code: "UNAUTHORIZED" as const, message: "Customer session required" }));
    const handler = createReferenceJourneyCustomerReadbackHandler({ authorize, actorPort, readback: port });
    const anonymous = response(); await handler(req(), anonymous.res); expect(anonymous.output.status).toBe(401); expect(actorPort).not.toHaveBeenCalled();
    authorize.mockResolvedValueOnce({ ok: true, userId: "owner", accessToken: "bearer-a" } as never); const malformed = response(); await handler(req({ operation: "list", extra: "no" }), malformed.res);
    expect(malformed.output.status).toBe(400); expect(actorPort).not.toHaveBeenCalled();
  });

  it("binds the verified customer principal to actor RLS and returns only order identity", async () => {
    const asActor = vi.fn(async (_claims, work) => work({}));
    const actorPort = vi.fn(() => ({ asActor }));
    const handler = createReferenceJourneyCustomerReadbackHandler({ authorize: async () => ({ ok: true, userId: "owner", accessToken: "bearer-a" }), actorPort, readback: port });
    const result = response(); await handler(req({ operation: "list", limit: "20" }), result.res);
    expect(actorPort).toHaveBeenCalledWith("bearer-a");
    expect(asActor).toHaveBeenCalledWith({ sub: "owner", role: "authenticated" }, expect.any(Function));
    expect(result.output).toEqual({ status: 200, body: { ok: true, data: { contractVersion: "reference.order-readback.v1", orders: [{ orderId: ORDER }] } } });
  });

  it("keeps operator service work behind authorization, governance, and strict parsing", async () => {
    const asService = vi.fn(), servicePort = vi.fn(() => ({ asService: asService as never })), authorize = vi.fn(async () => ({ ok: false as const, code: "FORBIDDEN" as const, message: "Admin role required" }));
    const handler = createReferenceJourneyOperatorReadbackHandler({ authorize, servicePort, governance: () => ({ flagEnabled: true, auditClient: { rpc: vi.fn() } }), readback: port });
    const denied = response(); await handler(req({ operation: "list" }), denied.res); expect(denied.output.status).toBe(403); expect(servicePort).not.toHaveBeenCalled(); expect(asService).not.toHaveBeenCalled();
    authorize.mockResolvedValueOnce({ ok: true, userId: "admin", isMachineActor: false } as never); const malformed = response(); await handler(req({ operation: "list", nope: "1" }), malformed.res);
    expect(malformed.output.status).toBe(400); expect(servicePort).not.toHaveBeenCalled(); expect(asService).not.toHaveBeenCalled();
  });

  it("runs the authorized operator identity read and its lazy machine audit", async () => {
    const events: string[] = [], rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data: null, error: null }));
    const asService = async <T>(work: (client: unknown) => Promise<T>): Promise<T> => { events.push("service"); return work({}); };
    const handler = createReferenceJourneyOperatorReadbackHandler({ authorize: async () => ({ ok: true, userId: "machine", isMachineActor: true }), servicePort: () => ({ asService }), governance: () => ({ flagEnabled: true, auditClient: { rpc: async (fn: string, args: Record<string, unknown>) => { events.push("audit"); return rpc(fn, args); } } }), readback: port });
    const result = response(); await handler(req({ operation: "detail", orderId: ORDER }), result.res);
    expect(events).toEqual(["service", "audit"]); expect(result.output.status).toBe(200); expect(rpc).toHaveBeenCalledOnce();
  });

  it("does not audit a missing operator detail or any human read", async () => {
    const audit = vi.fn(async () => ({ data: null, error: null }));
    const asServiceMissing = vi.fn(async (work) => work({}));
    port.getOperatorOrder.mockResolvedValueOnce(null as never);
    const machine = createReferenceJourneyOperatorReadbackHandler({
      authorize: async () => ({ ok: true, userId: "machine", isMachineActor: true }),
      servicePort: () => ({ asService: asServiceMissing }),
      governance: () => ({ flagEnabled: true, auditClient: { rpc: audit } }),
      readback: port,
    });
    const missing = response();
    await machine(req({ operation: "detail", orderId: ORDER }), missing.res);
    expect(missing.output.status).toBe(404);
    expect(audit).not.toHaveBeenCalled();

    const human = createReferenceJourneyOperatorReadbackHandler({
      authorize: async () => ({ ok: true, userId: "human", isMachineActor: false }),
      servicePort: () => ({ asService: async (work) => work({}) }),
      governance: () => ({ flagEnabled: false, auditClient: { rpc: audit } }),
      readback: port,
    });
    const listed = response();
    await human(req({ operation: "list" }), listed.res);
    expect(listed.output.status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("blocks a disabled machine before any service read", async () => {
    const servicePort = vi.fn();
    const handler = createReferenceJourneyOperatorReadbackHandler({
      authorize: async () => ({ ok: true, userId: "machine", isMachineActor: true }),
      servicePort,
      governance: () => ({ flagEnabled: false, auditClient: { rpc: vi.fn() } }),
      readback: port,
    });
    const result = response();
    await handler(req({ operation: "list" }), result.res);
    expect(result.output.status).toBe(503);
    expect(servicePort).not.toHaveBeenCalled();
  });
});
