import { describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../server/_lib/types/http.js";
const mocks = vi.hoisted(() => ({ service: vi.fn(), customer: vi.fn() }));
vi.mock("../../server/_lib/customer-domain/auth.js", () => ({ createCustomerServiceClient: mocks.service, createCustomerClient: mocks.customer }));
import { createReferenceAccountHandlers } from "../../server/runtime/public-reference/subscriptionAccount.js";

describe("selected subscription profile action guard", () => {
  it.each(["change_shipping_address", "gift_next_box", "resume", "cancel", undefined])("refuses unsupported action %s before customer binding or mutation", async (action) => {
    mocks.service.mockReturnValue({});
    mocks.customer.mockClear();
    const handlers = createReferenceAccountHandlers({ url: "http://127.0.0.1:54321", anonKey: "anon", serviceRoleKey: "service" }, "http://127.0.0.1:54330");
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() } as unknown as HttpResponse;
    await handlers.renewal({ headers: {}, body: { action } } as HttpRequest, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.customer).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });
});
