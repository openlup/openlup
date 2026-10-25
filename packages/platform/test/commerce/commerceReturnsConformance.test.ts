import { describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../src/http/index.js";
import { createBffResponder } from "../../src/bff/index.js";
import {
  createAdminReturnApproveHandler, createAdminReturnRejectHandler, createSupabaseCommerceReturnsPort,
} from "../../src/commerce/server/index.js";

const ORDER = "11111111-1111-4111-8111-111111111111", HOLD = "22222222-2222-4222-8222-222222222222";
const OP = "33333333-3333-4333-8333-333333333333", ACTOR = "operator-example";
const authorizeAdmin = async () => ({ ok: true as const, userId: ACTOR, isMachineActor: false });
const base = { idempotencyKey: "command-example", orderId: ORDER, reason: "operator confirmed" };
const responder = createBffResponder();
async function invoke(handler: ReturnType<typeof createAdminReturnApproveHandler>, body: unknown) {
  let status = 0;
  let response: unknown;
  const res = { setHeader() {}, status(code: number) { status = code; return res; }, json(value: unknown) { response = value; return res; } };
  await handler({ method: "POST", body } as HttpRequest, res as HttpResponse);
  return { status, body: response };
}
describe("commerce returns conformance", () => {
  it("exposes only request/approve/reject and carries their record/replay results", async () => {
    const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) => ({
      data: { returnRequestId: HOLD, status: name.endsWith("approve") ? "approved" : name.endsWith("reject") ? "rejected" : "requested", replayed: true } as unknown,
      error: null as { code: string; message: string } | null }));
    const port = createSupabaseCommerceReturnsPort({ rpc });
    expect(Object.keys(port).sort()).toEqual(["approve", "createRequest", "reject"]);
    expect(await port.createRequest({ ...base, reasonCode: "damaged", lines: [{ orderItemId: OP, quantity: 1 }] }))
      .toEqual({ returnRequestId: HOLD, status: "requested", replayed: true });
    const input = { idempotencyKey: base.idempotencyKey, returnRequestId: HOLD };
    const approve = createAdminReturnApproveHandler({ port, authorizeAdmin, responder });
    const reject = createAdminReturnRejectHandler({ port, authorizeAdmin, responder });
    for (const [handler, status] of [[approve, "approved"], [reject, "rejected"]] as const) {
      for (let replay = 0; replay < 2; replay++) expect(await invoke(handler, input))
        .toMatchObject({ status: 200, body: { data: { returnRequestId: HOLD, status, replayed: true } } });
    }
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["commerce_return_request_create", "commerce_return_approve", "commerce_return_approve", "commerce_return_reject", "commerce_return_reject"]);
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[2]);
    expect(rpc.mock.calls[3]).toEqual(rpc.mock.calls[4]);
    rpc.mockResolvedValueOnce({ data: null, error: { code: "22023", message: "commerce_return_invalid_state" } });
    // Preserve the donor adapter's SQLSTATE-only error; the handler cannot recover the refusal text.
    expect(await invoke(approve, input)).toMatchObject({ status: 500, body: { error: { code: "INTERNAL" } } });
  });
});
