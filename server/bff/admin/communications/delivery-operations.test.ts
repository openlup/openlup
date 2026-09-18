import { describe, expect, it, vi } from "vitest";
import { createCommunicationsControlPlaneHandler } from "./delivery-operations.js";

function response() {
  const res = { statusCode: 200, payload: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, json(value: unknown) { this.payload = value; return this; }, end() { return this; }, setHeader() {} };
  return res;
}

const snapshot = {
  operations: [], totalCount: 0, controls: [], templates: [],
  health: { attempted: 0, accepted: 0, failed: 0 },
  readiness: { requiredControlCount: 0, disabledControlKeys: [] },
};

describe("communications control-plane handler", () => {
  it("fails closed before the port", async () => {
    const getDeliveryOperations = vi.fn();
    const res = response();
    await createCommunicationsControlPlaneHandler({
      authorizeAdmin: async () => false,
      port: { getDeliveryOperations, getDeliveryOperationEvents: vi.fn(), mutateDeliveryControl: vi.fn(), sendEmail: vi.fn() },
    })({ method: "GET", query: {} } as never, res as never);
    expect(res.statusCode).toBe(401);
    expect(getDeliveryOperations).not.toHaveBeenCalled();
  });

  it("reads neutral operations and mutates controls", async () => {
    const port = {
      getDeliveryOperations: vi.fn(async () => snapshot),
      getDeliveryOperationEvents: vi.fn(async () => ({ events: [] })),
      mutateDeliveryControl: vi.fn(async () => ({ updated: true as const, revision: 2 })),
      sendEmail: vi.fn(),
    };
    const handler = createCommunicationsControlPlaneHandler({ authorizeAdmin: async () => true, port });
    const get = response();
    await handler({ method: "GET", query: { page: "0", pageSize: "10" } } as never, get as never);
    expect(get.statusCode).toBe(200);
    expect(port.getDeliveryOperations).toHaveBeenCalledWith({ page: 0, pageSize: 10 });
    const post = response();
    await handler({ method: "POST", body: { action: "set-control", controlKey: "receipt", enabled: true } } as never, post as never);
    expect(post.statusCode).toBe(200);
    expect(port.mutateDeliveryControl).toHaveBeenCalledWith({ action: "set-control", controlKey: "receipt", enabled: true });
  });

  it("executes the mounted neutral send action", async () => {
    const sendEmail = vi.fn(async () => ({
      message: {
        id: "delivery-1", channel: "email" as const, recipientId: "recipient-1",
        templateSlug: "template-1", status: "sent" as const, provider: null,
        providerMessageId: null, skippedReason: null,
      },
    }));
    const port = {
      getDeliveryOperations: vi.fn(), getDeliveryOperationEvents: vi.fn(),
      mutateDeliveryControl: vi.fn(), sendEmail,
    };
    const res = response();
    await createCommunicationsControlPlaneHandler({ authorizeAdmin: async () => true, port })({
      method: "POST",
      body: {
        action: "send", recipientReference: "recipient-1",
        templateReference: "template-1", idempotencyKey: "send-1",
      },
    } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      ok: true,
      data: { accepted: true, deliveryReference: "delivery-1" },
    });
    expect(sendEmail).toHaveBeenCalledWith({
      recipientId: "recipient-1", templateSlug: "template-1", idempotencyKey: "send-1",
    });
  });
});
