import { describe, expect, it, vi } from "vitest";
import * as commerce from "@openlup/platform/commerce/server";
import { bffResponder } from "../../_lib/bff/response.js";
import * as facade from "./commerceReturnsHandlers.js";
import { returnRequestCreateSchema } from "./commerceReturnsPort.js";
vi.mock("@openlup/platform/commerce/server", async (importOriginal) => {
  const actual = await importOriginal<typeof commerce>();
  return { ...actual,
    createCustomerReturnRequestHandler: vi.fn(actual.createCustomerReturnRequestHandler),
    createAdminReturnApproveHandler: vi.fn(actual.createAdminReturnApproveHandler),
    createAdminReturnRejectHandler: vi.fn(actual.createAdminReturnRejectHandler),
  };
});
describe("returns responder binding", () => {
  it("binds customer responses to the reference responder", () => {
    const deps = { port: { createRequest: vi.fn() }, authenticateUser: vi.fn(), enabled: () => true };
    const handler = facade.createCustomerReturnRequestHandler(deps);
    expect(commerce.createCustomerReturnRequestHandler).toHaveBeenLastCalledWith({ ...deps, responder: bffResponder, requestSchema: returnRequestCreateSchema });
    expect(handler).toBe(vi.mocked(commerce.createCustomerReturnRequestHandler).mock.results.at(-1)?.value);
  });
  it("binds approve and reject responses to the reference responder", () => {
    for (const name of ["createAdminReturnApproveHandler", "createAdminReturnRejectHandler"] as const) {
      const deps = { authorizeAdmin: vi.fn(), port: { approve: vi.fn(), reject: vi.fn() } };
      const handler = facade[name](deps);
      expect(commerce[name]).toHaveBeenLastCalledWith({ ...deps, responder: bffResponder });
      expect(handler).toBe(vi.mocked(commerce[name]).mock.results.at(-1)?.value);
    }
  });
});
