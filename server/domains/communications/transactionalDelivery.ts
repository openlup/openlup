import { createHash } from "node:crypto";

import {
  isTransactionalDeliveryIdentifier,
  type CapturedTransactionalDeliveryPort,
  type TransactionalDeliveryCommand,
  type TransactionalDeliveryReceipt,
  type TransactionalDeliveryReceiptStore,
} from "../../../src/domains/communications/transactionalDeliveryPort.js";

const FINGERPRINT = /^[a-f0-9]{64}$/;
const FAILURE_CODE = /^[a-z][a-z0-9_.-]{0,127}$/;

export class TransactionalDeliveryValidationError extends Error {
  constructor() {
    super("transactional_delivery_command_invalid");
  }
}

export class TransactionalDeliveryConflictError extends Error {
  constructor() {
    super("transactional_delivery_command_conflict");
  }
}

export class TransactionalDeliveryUnavailableError extends Error {
  constructor() {
    super("transactional_delivery_unavailable");
  }
}

function fingerprint(command: TransactionalDeliveryCommand): string {
  return createHash("sha256")
    .update(JSON.stringify({
      recipientReference: command.recipientReference,
      templateReference: command.templateReference,
      accessGrantReference: command.accessGrantReference ?? null,
    }))
    .digest("hex");
}

function validate(command: TransactionalDeliveryCommand): void {
  if (!isTransactionalDeliveryIdentifier(command.idempotencyKey)
    || !isTransactionalDeliveryIdentifier(command.recipientReference)
    || !isTransactionalDeliveryIdentifier(command.templateReference)
    || (command.accessGrantReference !== undefined
      && !isTransactionalDeliveryIdentifier(command.accessGrantReference))) {
    throw new TransactionalDeliveryValidationError();
  }
}

function accepted(
  receipt: TransactionalDeliveryReceipt,
  idempotencyKey: string,
  commandFingerprint: string,
): TransactionalDeliveryReceipt {
  if (receipt.idempotencyKey !== idempotencyKey || receipt.commandFingerprint !== commandFingerprint
    || receipt.state !== "accepted" || !isTransactionalDeliveryIdentifier(receipt.deliveryReference)
    || !Number.isInteger(receipt.attemptCount) || receipt.attemptCount < 1) {
    throw new Error("transactional_delivery_receipt_invalid");
  }
  return receipt;
}

/** One direct command, one captured delivery attempt, and one durable receipt transition. */
export function createTransactionalDelivery(
  deps: {
    store: TransactionalDeliveryReceiptStore;
    delivery: CapturedTransactionalDeliveryPort;
  },
  options: { fingerprint?: (command: TransactionalDeliveryCommand) => string } = {},
): { send(command: TransactionalDeliveryCommand): Promise<TransactionalDeliveryReceipt> } {
  const commandFingerprint = options.fingerprint ?? fingerprint;
  return {
    async send(command): Promise<TransactionalDeliveryReceipt> {
      validate(command);
      const digest = commandFingerprint(command);
      if (!FINGERPRINT.test(digest)) throw new Error("transactional_delivery_fingerprint_invalid");
      const prior = await deps.store.readReceipt(command.idempotencyKey);
      if (prior) {
        if (prior.commandFingerprint !== digest) throw new TransactionalDeliveryConflictError();
        if (prior.state === "accepted") return accepted(prior, command.idempotencyKey, digest);
      }

      try {
        const { deliveryReference } = await deps.delivery.deliver(command);
        if (!isTransactionalDeliveryIdentifier(deliveryReference)) throw new Error("captured_delivery_reference_invalid");
        try {
          return accepted(await deps.store.recordAccepted({
            idempotencyKey: command.idempotencyKey,
            commandFingerprint: digest,
            deliveryReference,
          }), command.idempotencyKey, digest);
        } catch {
          // Delivery may already have happened. Never turn an accepted-write
          // failure into a durable failed receipt for the same command.
          throw new TransactionalDeliveryUnavailableError();
        }
      } catch (error) {
        if (error instanceof TransactionalDeliveryUnavailableError) throw error;
        try {
          await deps.store.recordFailed({
            idempotencyKey: command.idempotencyKey,
            commandFingerprint: digest,
            errorCode: "captured_delivery_failed",
          });
        } catch {
          // The caller still receives the same sanitized unavailable result.
        }
        throw new TransactionalDeliveryUnavailableError();
      }
    },
  };
}
