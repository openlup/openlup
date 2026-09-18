import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PLATFORM_BUNDLE } from "../../domains/platform-runtime/platformKernel.js";
import { resolveSubscriptionActivationBinding } from "./subscriptionActivationBinding.js";

const ORDER = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "postgres://postgres:postgres@127.0.0.1:5432/platform";

const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
const createPool = vi.fn(() => pool);

describe("subscription activation binding", () => {
  beforeEach(() => {
    createPool.mockClear();
    pool.end.mockClear();
    pool.query.mockReset().mockResolvedValue({
      rows: [{ result: { orderId: ORDER, state: "provisional", cadenceDays: 28, declared: true, replayed: false } }],
    });
  });

  it("answers nothing off its own bundle, and opens no connection there", () => {
    expect(resolveSubscriptionActivationBinding(
      { PLATFORM_BUNDLE: DEFAULT_PLATFORM_BUNDLE, DATABASE_URL: CONNECTION }, { createPool },
    )).toBeNull();
    // The bundle is right but nothing says where the database is: still nothing, still no pool.
    expect(resolveSubscriptionActivationBinding({ PLATFORM_BUNDLE: "node-postgres" }, { createPool })).toBeNull();
    expect(resolveSubscriptionActivationBinding(
      { PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "   " }, { createPool },
    )).toBeNull();
    expect(createPool).not.toHaveBeenCalled();
  });

  it("owns the pool for exactly the operation, and closes it even when the work throws", async () => {
    const binding = resolveSubscriptionActivationBinding(
      { PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: CONNECTION }, { createPool },
    );
    expect(createPool).not.toHaveBeenCalled();

    const declared = await binding!.run((activation) => activation.declareProvisionalActivation({
      idempotencyKey: "declare-key-1", orderId: ORDER, cadenceDays: 28,
    }));
    expect(declared.state).toBe("provisional");
    expect(createPool).toHaveBeenCalledWith({ connectionString: CONNECTION });
    expect(pool.end).toHaveBeenCalledTimes(1);

    await expect(binding!.run(async () => { throw new Error("caller failed"); })).rejects.toThrow("caller failed");
    expect(pool.end).toHaveBeenCalledTimes(2);
  });

  it("calls the routine by name with named arguments and binds every value", async () => {
    const binding = resolveSubscriptionActivationBinding(
      { PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: CONNECTION }, { createPool },
    );
    await binding!.run((activation) => activation.declareProvisionalActivation({
      idempotencyKey: "declare-key-1", orderId: ORDER, cadenceDays: 28,
    }));

    const [text, values] = pool.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(text).toBe('SELECT public."subscription_declare_provisional_activation"'
      + '("p_idempotency_key" => $1,"p_order_id" => $2,"p_cadence_days" => $3) AS result');
    // Nothing the caller supplied is ever interpolated into the statement.
    expect(values).toEqual(["declare-key-1", ORDER, 28]);
  });

  it("refuses an answer that is not one row carrying one result", async () => {
    const binding = resolveSubscriptionActivationBinding(
      { PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: CONNECTION }, { createPool },
    );
    pool.query.mockResolvedValueOnce({ rows: [] });
    await expect(binding!.run((activation) => activation.readOfferReadiness({
      sourceKey: "source", sku: "sku",
    }))).rejects.toThrow("commerce_offer_readiness response invalid");
    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});
