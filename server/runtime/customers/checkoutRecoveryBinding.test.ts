import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PLATFORM_BUNDLE } from "../../domains/platform-runtime/platformKernel.js";
import { resolveDirectCheckoutRecoveryBinding } from "./checkoutRecoveryBinding.js";

const lane = {
  close: vi.fn(async () => undefined),
  create: vi.fn(),
  query: vi.fn(),
  run: vi.fn(),
};

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";

describe("direct checkout recovery binding", () => {
  beforeEach(() => {
    lane.close.mockClear();
    lane.query.mockReset().mockResolvedValue({
      rows: [{
        result: {
          tokenId: "33333333-3333-4333-8333-333333333333",
          orderId: ORDER_ID,
          clientId: CLIENT_ID,
          mode: "subscription_cycle",
          status: "pending_payment",
          subscriptionId: "44444444-4444-4444-8444-444444444444",
          tokenState: "active",
        },
      }],
    });
    lane.run.mockReset().mockImplementation(async (work) => work({ query: lane.query }));
    lane.create.mockReset().mockReturnValue({ run: lane.run, close: lane.close });
  });

  it("keeps managed and unconfigured direct bundles outside the transaction lane", () => {
    expect(resolveDirectCheckoutRecoveryBinding({ PLATFORM_BUNDLE: DEFAULT_PLATFORM_BUNDLE }))
      .toBeNull();
    expect(resolveDirectCheckoutRecoveryBinding({ PLATFORM_BUNDLE: "node-postgres" }))
      .toBeNull();
    expect(lane.create).not.toHaveBeenCalled();
  });

  it("executes the real token adapter through a bounded lane and closes it", async () => {
    const binding = resolveDirectCheckoutRecoveryBinding({
      PLATFORM_BUNDLE: "node-postgres",
      DATABASE_URL: "recovery-database",
    }, { createLane: lane.create });
    expect(binding).not.toBeNull();

    await expect(binding!.run(({ tokenPort }) => tokenPort.validate("raw-recovery-token")))
      .resolves.toMatchObject({ orderId: ORDER_ID, clientId: CLIENT_ID });

    expect(lane.create).toHaveBeenCalledWith({ connectionString: "recovery-database" });
    expect(lane.query).toHaveBeenCalledWith(
      'SELECT public."customer_checkout_recovery_token_inspect"("p_token_hash" => $1) AS result',
      ["59b5880d54ca8c991c09269834d59ea09ab4f467fd4d580a932cd70c5b993fa4"],
    );
    expect(lane.close).toHaveBeenCalledOnce();
  });

  it("closes the lane when composed work refuses", async () => {
    const binding = resolveDirectCheckoutRecoveryBinding({
      PLATFORM_BUNDLE: "node-postgres",
      DATABASE_URL: "recovery-database",
    }, { createLane: lane.create });

    await expect(binding!.run(async () => {
      throw new Error("recovery-refused");
    })).rejects.toThrow("recovery-refused");
    expect(lane.close).toHaveBeenCalledOnce();
  });
});
