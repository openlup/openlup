import type {
  CapturedTransactionalDeliveryPort,
  TransactionalDeliveryCommand,
} from "../../../src/domains/communications/transactionalDeliveryPort.js";

export type CapturedTransactionalDeliveryOutcome =
  | { readonly state: "accepted"; readonly deliveryReference?: string }
  | { readonly state: "failed" };

/** Injected only by tests and the parity proof to demonstrate durable recovery. */
export type CapturedTransactionalDeliveryOutcomeSource = (
  command: TransactionalDeliveryCommand,
) => Promise<CapturedTransactionalDeliveryOutcome> | CapturedTransactionalDeliveryOutcome;

/** Deterministic no-egress delivery adapter for the portable direct action. */
export function createCapturedTransactionalDelivery(
  options: { outcome?: CapturedTransactionalDeliveryOutcomeSource } = {},
): CapturedTransactionalDeliveryPort {
  return {
    async deliver(command) {
      const outcome = await (options.outcome?.(command) ?? { state: "accepted" as const });
      if (outcome.state === "failed") throw new Error("captured_delivery_failed");
      const deliveryReference = outcome.deliveryReference
        ?? `captured:${createHash("sha256").update(command.idempotencyKey).digest("hex")}`;
      return { deliveryReference };
    },
  };
}
import { createHash } from "node:crypto";
