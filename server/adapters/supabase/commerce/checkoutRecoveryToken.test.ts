import { describe, expect, it } from "vitest";

import { hashCheckoutRecoveryToken } from "../../../domains/commerce/checkoutRecoveryToken.js";
import { createSupabaseCheckoutRecoveryTokenPort } from "./checkoutRecoveryToken.js";

describe("supabase checkout recovery token port", () => {
  it("issue passes the HASH (never the raw token) to the RPC and returns the id", async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const port = createSupabaseCheckoutRecoveryTokenPort({
      rpc: (fn, args) => {
        calls.push({ fn, args });
        return Promise.resolve({ data: "tok-id-1", error: null });
      },
    });
    const id = await port.issue({
      orderId: "o1",
      rawToken: "raw-secret",
      expiresAt: "2026-07-08T00:00:00.000Z",
    });
    expect(id).toBe("tok-id-1");
    expect(calls[0].fn).toBe("commerce_checkout_recovery_token_issue");
    expect(calls[0].args.p_token_hash).toBe(hashCheckoutRecoveryToken("raw-secret"));
    expect(calls[0].args.p_token_hash).not.toBe("raw-secret");
    expect(calls[0].args.p_order_id).toBe("o1");
  });

  it("issue throws when the RPC returns no id", async () => {
    const port = createSupabaseCheckoutRecoveryTokenPort({
      rpc: () => Promise.resolve({ data: null, error: null }),
    });
    await expect(
      port.issue({ orderId: "o1", rawToken: "r", expiresAt: "2026-07-08T00:00:00.000Z" }),
    ).rejects.toThrow(/no token id/);
  });

  it("validate returns the order context for a valid token row", async () => {
    const port = createSupabaseCheckoutRecoveryTokenPort({
      rpc: () =>
        Promise.resolve({
          data: [
            {
              token_id: "tok-1",
              order_id: "o1",
              client_id: "c1",
              mode: "subscription_cycle",
              status: "pending_payment",
            },
          ],
          error: null,
        }),
    });
    expect(await port.validate("raw-secret")).toEqual({
      tokenId: "tok-1",
      orderId: "o1",
      clientId: "c1",
      mode: "subscription_cycle",
      status: "pending_payment",
    });
  });

  it("validate passes p_now when an explicit clock is given", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const port = createSupabaseCheckoutRecoveryTokenPort({
      rpc: (_fn, args) => {
        calls.push(args);
        return Promise.resolve({ data: [], error: null });
      },
    });
    await port.validate("raw-secret", new Date("2026-07-08T00:00:00.000Z"));
    expect(calls[0].p_now).toBe("2026-07-08T00:00:00.000Z");
  });

  it("validate returns null when the RPC yields no rows", async () => {
    const port = createSupabaseCheckoutRecoveryTokenPort({
      rpc: () => Promise.resolve({ data: [], error: null }),
    });
    expect(await port.validate("raw-secret")).toBeNull();
  });

  it("validate throws on RPC error", async () => {
    const port = createSupabaseCheckoutRecoveryTokenPort({
      rpc: () => Promise.resolve({ data: null, error: { message: "boom" } }),
    });
    await expect(port.validate("raw-secret")).rejects.toThrow(/boom/);
  });

  it("inspect passes only the HASH and returns dead-token subscription context", async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const port = createSupabaseCheckoutRecoveryTokenPort({
      rpc: (fn, args) => {
        calls.push({ fn, args });
        return Promise.resolve({
          data: [
            {
              token_id: "tok-1",
              order_id: "o1",
              client_id: "c1",
              mode: "subscription_cycle",
              status: "cancelled",
              subscription_id: "s1",
              token_state: "order_not_recoverable",
            },
          ],
          error: null,
        });
      },
    });

    await expect(port.inspect("raw-secret")).resolves.toEqual({
      tokenId: "tok-1",
      orderId: "o1",
      clientId: "c1",
      mode: "subscription_cycle",
      status: "cancelled",
      subscriptionId: "s1",
      tokenState: "order_not_recoverable",
    });
    expect(calls[0].fn).toBe("commerce_checkout_recovery_token_inspect");
    expect(calls[0].args.p_token_hash).toBe(hashCheckoutRecoveryToken("raw-secret"));
    expect(calls[0].args.p_token_hash).not.toBe("raw-secret");
  });

  it("inspect returns null when the RPC yields no rows", async () => {
    const port = createSupabaseCheckoutRecoveryTokenPort({
      rpc: () => Promise.resolve({ data: [], error: null }),
    });
    expect(await port.inspect("raw-secret")).toBeNull();
  });
});
