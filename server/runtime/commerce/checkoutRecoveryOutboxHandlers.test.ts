import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { resolveCheckoutRecoveryOutboxHandlerScope } from "./checkoutRecoveryOutboxHandlers.js";

const reminderCommand = {
  idempotencyKey: "checkout-reminder:event",
  recipientReference: "client:one",
  templateReference: "commerce-checkout-recovery",
};

function reminderFingerprint(): string {
  return createHash("sha256").update(JSON.stringify({
    recipientReference: reminderCommand.recipientReference,
    templateReference: reminderCommand.templateReference,
    accessGrantReference: null,
  })).digest("hex");
}

describe("checkout recovery outbox handlers", () => {
  it("does not open persistence when checkout reminder handlers are disabled", async () => {
    const resolved = resolveCheckoutRecoveryOutboxHandlerScope({ PLATFORM_BUNDLE: "node-postgres" });

    expect(resolved.scope?.requested).toBe(false);
    await expect(resolved.scope?.run(async (handlers) => handlers)).resolves.toEqual([]);
  });

  it("fails closed before composition when direct persistence is unavailable", () => {
    expect(resolveCheckoutRecoveryOutboxHandlerScope({
      PLATFORM_BUNDLE: "node-postgres",
      COMMERCE_CHECKOUT_RECOVERY_ENABLED: "true",
    })).toEqual({ error: "database_url_required" });
  });

  it("composes requested direct handlers through both named bindings and closes them", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: [{ result: sql.includes("delivery_authorize")
      ? { authorized: true, ...reminderCommand }
      : {} }] }));
    const closeLane = vi.fn(async () => undefined);
    const store = {
      readReceipt: vi.fn(async () => null),
      recordAccepted: vi.fn(async () => ({
        ...reminderCommand,
        commandFingerprint: reminderFingerprint(),
        state: "accepted" as const,
        deliveryReference: "captured:checkout-reminder",
        errorCode: null,
        attemptCount: 1,
      })),
      recordFailed: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const resolved = resolveCheckoutRecoveryOutboxHandlerScope({
      PLATFORM_BUNDLE: "node-postgres",
      DATABASE_URL: "postgres://platform",
      COMMERCE_ABANDONED_CART_ENABLED: "true",
      COMMERCE_CHECKOUT_RECOVERY_ENABLED: "true",
    }, {
      operationsBinding: {
        createLane: () => ({
          run: (work) => work({ query } as never),
          close: closeLane,
        }),
      },
      transactionalBinding: {
        postgresStoreFactory: () => store,
        capturedFactory: () => ({ deliver: vi.fn(async () => ({
          deliveryReference: "captured:checkout-reminder",
        })) }),
      },
    });

    expect(resolved.error).toBeUndefined();
    expect(resolved.scope?.requested).toBe(true);
    await expect(resolved.scope?.run(async (handlers) => {
      expect(handlers.map((handler) => handler.eventType)).toEqual([
        "commerce.order_draft.abandoned.1h",
        "commerce.order_draft.abandoned.24h",
        "commerce.order_draft.abandoned.72h",
        "commerce.checkout_recovery",
      ]);
      return handlers.at(-1)!.handle({
        id: "8efaf14b-409f-4a08-b745-5110f565c18c",
        created_at: "2026-08-18T00:00:00.000Z",
        available_at: "2026-08-18T00:00:00.000Z",
        processed_at: null,
        aggregate_type: "commerce_order",
        aggregate_id: "45d3f50a-120d-44b2-a94e-2baa04c21722",
        event_type: "commerce.checkout_recovery",
        idempotency_key: "checkout_recovery:1h:order",
        status: "processing",
        attempts: 1,
        payload: {},
        error: null,
        metadata: { claimToken: "claim-token" },
      }, new AbortController().signal);
    })).resolves.toEqual({
      kind: "processed",
      detail: { captured: "accepted", attempts: 1 },
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("delivery_authorize"), [
      "8efaf14b-409f-4a08-b745-5110f565c18c",
      "claim-token",
    ]);
    expect(store.close).toHaveBeenCalledOnce();
    expect(closeLane).toHaveBeenCalledOnce();
  });
});
