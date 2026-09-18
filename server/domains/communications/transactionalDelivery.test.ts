import { describe, expect, it, vi } from "vitest";

import {
  TransactionalDeliveryConflictError,
  TransactionalDeliveryUnavailableError,
  createTransactionalDelivery,
} from "./transactionalDelivery.js";
import { createCapturedTransactionalDelivery } from "../../adapters/captured/transactionalDelivery.js";
import type {
  CapturedTransactionalDeliveryPort,
  TransactionalDeliveryReceipt,
  TransactionalDeliveryReceiptStore,
} from "../../../src/domains/communications/transactionalDeliveryPort.js";

const command = {
  idempotencyKey: "delivery:attempt-1",
  recipientReference: "recipient-1",
  templateReference: "template-1",
};

function deps(receipt: TransactionalDeliveryReceipt | null = null) {
  return {
    store: {
      readReceipt: vi.fn<TransactionalDeliveryReceiptStore["readReceipt"]>(async () => receipt),
      recordAccepted: vi.fn<TransactionalDeliveryReceiptStore["recordAccepted"]>(async (input) => ({
        idempotencyKey: input.idempotencyKey,
        commandFingerprint: input.commandFingerprint,
        state: "accepted" as const,
        deliveryReference: input.deliveryReference,
        errorCode: null,
        attemptCount: 1,
      })),
      recordFailed: vi.fn<TransactionalDeliveryReceiptStore["recordFailed"]>(async (input) => ({
        idempotencyKey: input.idempotencyKey,
        commandFingerprint: input.commandFingerprint,
        state: "failed" as const,
        deliveryReference: null,
        errorCode: input.errorCode,
        attemptCount: 1,
      })),
    } satisfies TransactionalDeliveryReceiptStore,
    delivery: { deliver: vi.fn<CapturedTransactionalDeliveryPort["deliver"]>(async () => ({ deliveryReference: "captured:delivery-1" })) } satisfies CapturedTransactionalDeliveryPort,
  };
}

describe("transactional captured delivery", () => {
  it("delivers once and writes only an accepted receipt", async () => {
    const input = deps();
    const delivery = createTransactionalDelivery(input);

    await expect(delivery.send(command)).resolves.toMatchObject({
      state: "accepted",
      deliveryReference: "captured:delivery-1",
      attemptCount: 1,
    });
    expect(input.store.readReceipt).toHaveBeenCalledWith(command.idempotencyKey);
    expect(input.delivery.deliver).toHaveBeenCalledWith(command);
    expect(input.store.recordAccepted).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: command.idempotencyKey,
      deliveryReference: "captured:delivery-1",
      commandFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(input.store.recordFailed).not.toHaveBeenCalled();
  });

  it("persists a sanitized failure before returning an unavailable result", async () => {
    const input = deps();
    input.delivery.deliver.mockRejectedValueOnce(new Error("provider reply must not persist"));

    await expect(createTransactionalDelivery(input).send(command)).rejects.toBeInstanceOf(TransactionalDeliveryUnavailableError);
    expect(input.store.recordFailed).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: command.idempotencyKey,
      errorCode: "captured_delivery_failed",
      commandFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it("does not overwrite a delivered receipt as failed when accepted persistence fails", async () => {
    const input = deps();
    input.store.recordAccepted.mockRejectedValueOnce(new Error("receipt write details"));

    await expect(createTransactionalDelivery(input).send(command)).rejects.toEqual(
      new TransactionalDeliveryUnavailableError(),
    );
    expect(input.delivery.deliver).toHaveBeenCalledOnce();
    expect(input.store.recordFailed).not.toHaveBeenCalled();
  });

  it("replays an accepted receipt without another captured delivery", async () => {
    const input = deps({
      idempotencyKey: command.idempotencyKey,
      commandFingerprint: "f".repeat(64),
      state: "accepted",
      deliveryReference: "captured:existing",
      errorCode: null,
      attemptCount: 2,
    });
    const delivery = createTransactionalDelivery(input, { fingerprint: () => "f".repeat(64) });

    await expect(delivery.send(command)).resolves.toMatchObject({ state: "accepted", attemptCount: 2 });
    expect(input.delivery.deliver).not.toHaveBeenCalled();
    expect(input.store.recordAccepted).not.toHaveBeenCalled();
  });

  it("fails closed when a key is reused for another command", async () => {
    const input = deps({
      idempotencyKey: command.idempotencyKey,
      commandFingerprint: "0".repeat(64),
      state: "failed",
      deliveryReference: null,
      errorCode: "captured_delivery_failed",
      attemptCount: 1,
    });

    await expect(createTransactionalDelivery(input).send(command)).rejects.toBeInstanceOf(TransactionalDeliveryConflictError);
    expect(input.delivery.deliver).not.toHaveBeenCalled();
    expect(input.store.recordAccepted).not.toHaveBeenCalled();
    expect(input.store.recordFailed).not.toHaveBeenCalled();
  });

  it("carries an access grant and binds it into the replay fingerprint", async () => {
    const input = deps();
    const withGrant = { ...command, accessGrantReference: "review-grant:11111111-1111-4111-8111-111111111111" };
    await createTransactionalDelivery(input).send(withGrant);
    expect(input.delivery.deliver).toHaveBeenCalledWith(withGrant);
    const fingerprint = input.store.recordAccepted.mock.calls[0]![0].commandFingerprint;

    const replay = deps({
      idempotencyKey: command.idempotencyKey,
      commandFingerprint: fingerprint,
      state: "accepted",
      deliveryReference: "captured:existing",
      errorCode: null,
      attemptCount: 1,
    });
    await expect(createTransactionalDelivery(replay).send(command))
      .rejects.toBeInstanceOf(TransactionalDeliveryConflictError);
  });

  it("rejects a malformed access grant before delivery", async () => {
    const input = deps();
    await expect(createTransactionalDelivery(input).send({
      ...command,
      accessGrantReference: "contains whitespace",
    })).rejects.toThrow("transactional_delivery_command_invalid");
    expect(input.delivery.deliver).not.toHaveBeenCalled();
  });

  it("accepts a maximum-length opaque key with the default captured action", async () => {
    const input = deps();
    const result = await createTransactionalDelivery({
      store: input.store,
      delivery: createCapturedTransactionalDelivery(),
    }).send({ ...command, idempotencyKey: "a".repeat(256) });

    expect(result).toMatchObject({ state: "accepted" });
    expect(result.deliveryReference).toHaveLength(73);
  });
});
