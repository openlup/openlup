import { describe, expect, it } from "vitest";
import {
  createSupabaseCheckoutRecoverySubscriptionContextPort,
  type CheckoutRecoverySubscriptionContextSupabaseClient,
} from "./checkoutRecoverySubscriptionContext.js";
import { RECOVERY_CONTEXT_SUBSCRIPTION_STATUSES } from "../../../domains/commerce/checkoutRecoverySubscriptionContextPort.js";

const CLIENT_ID = "33333333-3333-4333-8333-333333333333";

function fakeClient(opts: {
  rows?: Array<Record<string, unknown>>;
  error?: string;
  eqLog?: Array<[string, unknown]>;
  inLog?: Array<[string, readonly unknown[]]>;
}): CheckoutRecoverySubscriptionContextSupabaseClient {
  const chain = {
    select: () => chain,
    eq: (column: string, value: unknown) => {
      opts.eqLog?.push([column, value]);
      return chain;
    },
    in: (column: string, values: readonly unknown[]) => {
      opts.inLog?.push([column, values]);
      return chain;
    },
    limit: async () =>
      opts.error
        ? { data: null, error: { message: opts.error } }
        : { data: opts.rows ?? [], error: null },
  };
  return { from: () => chain as never };
}

describe("checkout recovery subscription context port", () => {
  it("finds live or pending subscription context by client id", async () => {
    const eqLog: Array<[string, unknown]> = [];
    const inLog: Array<[string, readonly unknown[]]> = [];
    const port = createSupabaseCheckoutRecoverySubscriptionContextPort(
      fakeClient({ rows: [{ id: "sub_1" }], eqLog, inLog }),
    );

    await expect(port.clientHasLiveOrPendingSubscription({ clientId: CLIENT_ID })).resolves.toBe(true);
    expect(eqLog).toContainEqual(["client_id", CLIENT_ID]);
    expect(inLog).toContainEqual(["status", RECOVERY_CONTEXT_SUBSCRIPTION_STATUSES]);
  });

  it("returns false when no live or pending subscription row exists", async () => {
    const port = createSupabaseCheckoutRecoverySubscriptionContextPort(fakeClient({ rows: [] }));
    await expect(port.clientHasLiveOrPendingSubscription({ clientId: CLIENT_ID })).resolves.toBe(false);
  });

  it("throws explicit subscription lookup errors", async () => {
    const port = createSupabaseCheckoutRecoverySubscriptionContextPort(fakeClient({ error: "boom" }));
    await expect(port.clientHasLiveOrPendingSubscription({ clientId: CLIENT_ID })).rejects.toThrow(
      /subscriptions: boom/,
    );
  });
});
