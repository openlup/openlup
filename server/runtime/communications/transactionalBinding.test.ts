import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createNodePostgresTransactionalRuntime,
  resolveTransactionalDeliveryBinding,
} from "./transactionalBinding.js";

const command = { idempotencyKey: "delivery:1", recipientReference: "recipient-1", templateReference: "template-1" };
const fingerprint = createHash("sha256").update(JSON.stringify({
  recipientReference: command.recipientReference,
  templateReference: command.templateReference,
  accessGrantReference: null,
})).digest("hex");
const accepted = {
  idempotencyKey: command.idempotencyKey, commandFingerprint: fingerprint, state: "accepted" as const,
  deliveryReference: "captured:delivery-1", errorCode: null, attemptCount: 1,
};

function postgresStore() {
  return {
    readReceipt: vi.fn(async () => null),
    recordAccepted: vi.fn(async () => accepted),
    recordFailed: vi.fn(async () => ({ ...accepted, state: "failed" as const, deliveryReference: null, errorCode: "captured_delivery_failed" })),
    close: vi.fn(async () => undefined),
  };
}

describe("transactional delivery binding", () => {
  it("binds node-postgres with a scoped store lifetime and no generic gateway", async () => {
    const store = postgresStore();
    const resolved = resolveTransactionalDeliveryBinding(
      { PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgres://platform" },
      { postgresStoreFactory: () => store },
    );
    expect(resolved.binding?.identity).toBe("node-postgres");
    await expect(resolved.binding?.run((delivery) => delivery.send(command))).resolves.toMatchObject({ state: "accepted" });
    expect(store.readReceipt).toHaveBeenCalledWith(command.idempotencyKey);
    await expect(resolved.binding?.run((delivery) => delivery.readReceipt(command.idempotencyKey))).resolves.toBeNull();
    expect(store.close).toHaveBeenCalledTimes(2);
  });

  it("answers node-postgres send-email through the binding but makes a missing database a 5xx", async () => {
    const missing = createNodePostgresTransactionalRuntime({ PLATFORM_BUNDLE: "node-postgres" });
    await expect(missing.invoke("send-email", command)).resolves.toEqual({ ok: false, status: 500 });
    await expect(missing.invoke("process-email-queue", command)).resolves.toEqual({ ok: false, status: 404 });

    const store = postgresStore();
    const runtime = createNodePostgresTransactionalRuntime(
      { PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgres://platform" },
      { postgresStoreFactory: () => store },
    );
    await expect(runtime.invoke("send-email", command)).resolves.toEqual({ ok: true, status: 202 });
    expect(store.close).toHaveBeenCalledOnce();
  });
});
