import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  createAdminReturnApproveHandler,
  createAdminReturnRejectHandler,
  createCustomerReturnRequestHandler,
} from "./commerceReturnsHandlers.js";

const OK = { returnRequestId: "ret-1", status: "requested", replayed: false };
const ORDER = "11111111-1111-4111-8111-111111111111";
const RID = "33333333-3333-4333-8333-333333333333";
const ITEM = "22222222-2222-4222-8222-222222222222";

function mockRes() {
  const out: { statusCode: number; body: Record<string, unknown> } = { statusCode: 0, body: {} };
  const res = {
    setHeader() {},
    status(code: number) { out.statusCode = code; return res; },
    json(b: Record<string, unknown>) { out.body = b; },
  };
  return { res: res as unknown as VercelResponse, out };
}

function req(method: string, body?: unknown): VercelRequest {
  return { method, headers: {}, body } as unknown as VercelRequest;
}

const validReturnBody = { idempotencyKey: "ret-idem-0001", orderId: ORDER, reasonCode: "damaged", lines: [{ orderItemId: ITEM, quantity: 1 }] };

describe("customer return request handler", () => {
  function build(opts: { enabled?: boolean; authed?: boolean; create?: () => Promise<unknown> }) {
    const create = vi.fn(opts.create ?? (async () => OK));
    return {
      create,
      handler: createCustomerReturnRequestHandler({
        port: { createRequest: create as never },
        authenticateUser: async () => (opts.authed === false ? { ok: false, code: "UNAUTHORIZED", message: "x" } : { ok: true, userId: "user-1" }),
        enabled: () => opts.enabled !== false,
      }),
    };
  }

  it("creates a return for an authed customer with a valid body", async () => {
    const { handler, create } = build({});
    const { res, out } = mockRes();
    await handler(req("POST", validReturnBody), res);
    expect(out.body).toMatchObject({ ok: true, data: OK });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ orderId: ORDER, requestedBy: "user-1" }));
  });

  it("rejects an unauthenticated request without calling the port", async () => {
    const { handler, create } = build({ authed: false });
    const { res, out } = mockRes();
    await handler(req("POST", validReturnBody), res);
    expect(out.body.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("fails closed when returns are disabled", async () => {
    const { handler, create } = build({ enabled: false });
    const { res, out } = mockRes();
    await handler(req("POST", validReturnBody), res);
    expect(out.body.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an invalid body (missing orderId)", async () => {
    const { handler, create } = build({});
    const { res, out } = mockRes();
    await handler(req("POST", { idempotencyKey: "ret-idem-0001", reasonCode: "damaged", lines: [] }), res);
    expect(out.body.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("maps an RPC validation error to a 400", async () => {
    const { handler } = build({ create: async () => { throw new Error("commerce_return_request_order_not_returnable"); } });
    const { res, out } = mockRes();
    await handler(req("POST", validReturnBody), res);
    expect(out.body.ok).toBe(false);
    expect(out.statusCode).toBe(400);
  });

  it("405s a non-POST", async () => {
    const { handler } = build({});
    const { res, out } = mockRes();
    await handler(req("GET"), res);
    expect(out.statusCode).toBe(405);
  });
});

describe("admin return approve/reject handlers", () => {
  const okAuth = async () => ({ ok: true as const, userId: "admin-1" });
  const denyAuth = async () => ({ ok: false as const, code: "FORBIDDEN" as const, message: "no" });

  it("approve: authorizes, then calls the port with the actor", async () => {
    const approve = vi.fn(async () => ({ ...OK, status: "approved" }));
    const handler = createAdminReturnApproveHandler({ authorizeAdmin: okAuth, port: { approve: approve as never } });
    const { res, out } = mockRes();
    await handler(req("POST", { idempotencyKey: "appr-0001", returnRequestId: RID, refundMode: "full" }), res);
    expect(out.body).toMatchObject({ ok: true });
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ returnRequestId: RID, actorUserId: "admin-1" }));
  });

  it("approve: blocks an unauthorized caller", async () => {
    const approve = vi.fn(async () => OK);
    const handler = createAdminReturnApproveHandler({ authorizeAdmin: denyAuth, port: { approve: approve as never } });
    const { res, out } = mockRes();
    await handler(req("POST", { idempotencyKey: "appr-0001", returnRequestId: RID }), res);
    expect(out.body.ok).toBe(false);
    expect(approve).not.toHaveBeenCalled();
  });


  it("reject: invalid-state RPC error maps to 400", async () => {
    const reject = vi.fn(async () => { throw new Error("commerce_return_reject_invalid_state"); });
    const handler = createAdminReturnRejectHandler({ authorizeAdmin: okAuth, port: { reject: reject as never } });
    const { res, out } = mockRes();
    await handler(req("POST", { idempotencyKey: "rej-0001", returnRequestId: RID }), res);
    expect(out.statusCode).toBe(400);
  });
});
