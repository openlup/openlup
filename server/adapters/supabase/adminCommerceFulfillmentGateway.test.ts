import { describe, expect, it, vi } from "vitest";
import { createSupabaseAdminCommerceFulfillmentGateway } from "./adminCommerceFulfillmentGateway.js";

describe("supabase admin commerce fulfillment gateway", () => {
  it("does not construct the service-role client until a port is used", () => {
    const clientFactory = vi.fn().mockReturnValue(fakeClient());

    const gateway = createSupabaseAdminCommerceFulfillmentGateway(env(), { clientFactory });

    expect(clientFactory).not.toHaveBeenCalled();
    gateway.readPort();
    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(clientFactory).toHaveBeenCalledWith(env());
    gateway.mutationPort();
    expect(clientFactory).toHaveBeenCalledTimes(1);
  });

  it("uses the base handoff port unless a decorator is provided", async () => {
    const client = fakeClient();
    const decorator = vi.fn();
    const gateway = createSupabaseAdminCommerceFulfillmentGateway(env(), {
      clientFactory: vi.fn().mockReturnValue(client),
    });

    await gateway.handoffPort().handOffCommerceFulfillmentOrder(handoffRequest());

    expect(decorator).not.toHaveBeenCalled();
  });

  it("can lazily decorate the handoff port with the shared service client", async () => {
    const client = fakeClient();
    const decorated = {
      handOffCommerceFulfillmentOrder: vi.fn().mockResolvedValue({
        contractVersion: "commerce.fulfillment.v0",
        fulfillmentOrderId: "52222222-2222-4222-8222-222222222221",
        orderId: "42222222-2222-4222-8222-222222222221",
        status: "handed_over",
        replayed: false,
      }),
    };
    const handoffPortDecorator = vi.fn().mockReturnValue(decorated);
    const gateway = createSupabaseAdminCommerceFulfillmentGateway(env(), {
      clientFactory: vi.fn().mockReturnValue(client),
      handoffPortDecorator,
    });

    await gateway.handoffPort().handOffCommerceFulfillmentOrder(handoffRequest());

    expect(handoffPortDecorator).toHaveBeenCalledWith(expect.objectContaining({
      handOffCommerceFulfillmentOrder: expect.any(Function),
    }), client);
    expect(decorated.handOffCommerceFulfillmentOrder).toHaveBeenCalledWith(handoffRequest());
  });
});

function env() {
  return { url: "https://supabase.example", serviceRoleKey: "service-role" };
}

function handoffRequest() {
  return {
    idempotencyKey: "handoff-1",
    fulfillmentOrderId: "52222222-2222-4222-8222-222222222221",
    actorUserId: "admin-user-1",
  };
}

function fakeClient() {
  return {
    rpc: vi.fn().mockResolvedValue({
      data: [{
        contract_version: "commerce.fulfillment.v0",
        fulfillment_order_id: "52222222-2222-4222-8222-222222222221",
        order_id: "42222222-2222-4222-8222-222222222221",
        status: "handed_over",
        replayed: false,
      }],
      error: null,
    }),
    from: vi.fn(),
  };
}
