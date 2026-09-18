import { describe, expect, it, vi } from "vitest";
import { createAdminChannelsGateway } from "./adminChannelsGateway.js";

const ENV = { url: "https://example.invalid", serviceRoleKey: "service-role-key" };

function stubClient() {
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (onfulfilled: (value: unknown) => unknown) =>
      Promise.resolve(onfulfilled({ data: null, error: null, count: 0 })),
  };
  return { from: () => builder };
}

describe("admin channels gateway", () => {
  it("hands back a ready read port rather than a client", () => {
    const port = createAdminChannelsGateway(ENV, { clientFactory: stubClient }).opsReadPort();

    // Three reads and nothing else: no writer, and no way back to the client it was built from.
    expect(Object.keys(port).sort()).toEqual([
      "countOpenQuarantine",
      "readOrderChannel",
      "readOrderIngest",
    ]);
  });

  it("builds the elevated client lazily, and only once", () => {
    const clientFactory = vi.fn(stubClient);
    const gateway = createAdminChannelsGateway(ENV, { clientFactory });

    // A request that never reaches a read never builds one.
    expect(clientFactory).not.toHaveBeenCalled();

    const first = gateway.opsReadPort();
    const second = gateway.opsReadPort();

    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(clientFactory).toHaveBeenCalledWith(ENV);
    expect(second).toBe(first);
  });

  it("drives the adapter it was given, so the port is wired rather than merely shaped", async () => {
    const port = createAdminChannelsGateway(ENV, { clientFactory: stubClient }).opsReadPort();

    // A storefront order: no channel row behind the id, answered as absent rather than thrown.
    await expect(port.readOrderChannel("order-1")).resolves.toBeNull();
    await expect(port.countOpenQuarantine("channel-1")).resolves.toBe(0);
  });
});
