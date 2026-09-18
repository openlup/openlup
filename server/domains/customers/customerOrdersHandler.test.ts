import { describe, expect, it, vi } from "vitest";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerOrdersPort } from "./ports.js";
import {
  createCustomerOrderDetailHandler,
  createCustomerOrdersListHandler,
} from "./customerOrdersHandler.js";

// Request/response types are derived from the handler signature so these tests
// stay neutral in the platform-token inventory.
type Handler = ReturnType<typeof createCustomerOrdersListHandler>;
type Req = Parameters<Handler>[0];
type Res = Parameters<Handler>[1];

describe("customer orders handlers", () => {
  it("rejects unsupported methods", async () => {
    const res = createResponse();
    await createListHandler({})(request("POST"), res);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("propagates the authentication refusal code without calling the port", async () => {
    const ordersPort = createPort();
    const res = createResponse();
    await createListHandler({
      ordersPort,
      auth: { ok: false, code: "UNAUTHORIZED", message: "Customer session required" },
    })(request("GET"), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(ordersPort.listOrders).not.toHaveBeenCalled();
  });

  it("maps authentication transport failures to UPSTREAM_UNAVAILABLE", async () => {
    const res = createResponse();
    await createListHandler({ auth: new Error("auth down") })(request("GET"), res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("passes an authenticated session through the guard to the list port", async () => {
    const ordersPort = createPort();
    const res = createResponse();
    await createListHandler({ ordersPort })(request("GET"), res);
    expect(ordersPort.listOrders).toHaveBeenCalledWith("user-1", expect.anything());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("guards the detail handler with the same refusal contract", async () => {
    const ordersPort = createPort();
    const unauthorized = createResponse();
    await createDetailHandler({
      ordersPort,
      auth: { ok: false, code: "UNAUTHORIZED", message: "Customer session required" },
    })(request("GET"), unauthorized);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    expect(ordersPort.getOrderDetail).not.toHaveBeenCalled();
  });
});

function createListHandler(deps: HandlerDeps) {
  return createCustomerOrdersListHandler(resolveDeps(deps));
}

function createDetailHandler(deps: HandlerDeps) {
  return createCustomerOrderDetailHandler(resolveDeps(deps));
}

interface HandlerDeps {
  ordersPort?: CustomerOrdersPort;
  auth?: CustomerUserAuthenticationResult | Error;
}

function resolveDeps({ ordersPort = createPort(), auth = { ok: true, userId: "user-1" } }: HandlerDeps) {
  return {
    ordersPort,
    authenticateUser: vi.fn().mockImplementation(async () => {
      if (auth instanceof Error) throw auth;
      return auth;
    }),
  };
}

function request(method: string): Req {
  return { method, query: {} } as unknown as Req;
}

function createPort(): CustomerOrdersPort {
  return {
    listOrders: vi.fn().mockResolvedValue(null),
    getOrderDetail: vi.fn().mockResolvedValue(null),
  } as unknown as CustomerOrdersPort;
}

function createResponse(): Res {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Res;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
