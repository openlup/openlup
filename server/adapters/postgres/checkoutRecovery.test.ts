import { describe, expect, it, vi } from "vitest";
import {
  createPostgresCheckoutRecoveryPayService,
  createPostgresCheckoutRecoveryTokenPort,
} from "./checkoutRecovery.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const INTENT_ID = "33333333-3333-4333-8333-333333333333";

describe("postgres checkout recovery", () => {
  it("hashes the raw token at the adapter edge and retains its validated authority", async () => {
    const seen: string[] = [];
    const rpc = vi.fn().mockResolvedValue({
      data: {
        tokenId: "44444444-4444-4444-8444-444444444444",
        orderId: ORDER_ID,
        clientId: CLIENT_ID,
        mode: "subscription_cycle",
        status: "pending_payment",
        subscriptionId: "55555555-5555-4555-8555-555555555555",
        tokenState: "active",
      },
      error: null,
    });
    const port = createPostgresCheckoutRecoveryTokenPort(
      { rpc },
      undefined,
      (hash) => seen.push(hash),
    );

    await expect(port.validate("raw-recovery-token")).resolves.toMatchObject({
      orderId: ORDER_ID,
      clientId: CLIENT_ID,
    });
    expect(rpc).toHaveBeenCalledWith("customer_checkout_recovery_token_inspect", {
      p_token_hash: "59b5880d54ca8c991c09269834d59ea09ab4f467fd4d580a932cd70c5b993fa4", // gitleaks:allow - fixed SHA-256 test oracle, not a credential
    });
    expect(seen).toEqual(["59b5880d54ca8c991c09269834d59ea09ab4f467fd4d580a932cd70c5b993fa4"]); // gitleaks:allow - same fixed oracle
  });

  it("settles only the captured rehearsal and maps the fixed response", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        orderId: ORDER_ID,
        paymentIntentId: INTENT_ID,
        clientId: CLIENT_ID,
        paymentAttemptId: null,
        provider: "hidden_rehearsal",
        providerPaymentId: `captured-${INTENT_ID}`,
      },
      error: null,
    });
    const service = createPostgresCheckoutRecoveryPayService(
      { rpc },
      () => "a".repeat(64),
    );

    await expect(service.pay({
      order: { orderId: ORDER_ID } as never,
      clientId: CLIENT_ID,
      paymentProvider: "hidden_rehearsal",
      paymentExecution: undefined,
      idempotencyKey: "recovery-settle-1",
    })).resolves.toMatchObject({
      orderId: ORDER_ID,
      status: "paid",
      paymentAttemptId: null,
      provider: "hidden_rehearsal",
      clientAction: { kind: "none" },
    });
    expect(rpc).toHaveBeenCalledWith("customer_checkout_recovery_settle", {
      p_token_hash: "a".repeat(64),
      p_idempotency_key: "recovery-settle-1",
    });
  });

  it("fails closed without validated authority or for a provider execution request", async () => {
    const rpc = vi.fn();
    const missing = createPostgresCheckoutRecoveryPayService({ rpc }, () => null);
    const provider = createPostgresCheckoutRecoveryPayService({ rpc }, () => "a".repeat(64));
    const base = {
      order: { orderId: ORDER_ID } as never,
      clientId: CLIENT_ID,
      idempotencyKey: "recovery-settle-2",
      paymentExecution: undefined,
    };

    await expect(missing.pay({ ...base, paymentProvider: "hidden_rehearsal" }))
      .rejects.toMatchObject({
        name: "CheckoutRecoveryPayError",
        code: "provider_execution_failed",
        orderId: ORDER_ID,
      });
    await expect(provider.pay({ ...base, paymentProvider: "stripe" }))
      .rejects.toMatchObject({ code: "provider_execution_failed" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
