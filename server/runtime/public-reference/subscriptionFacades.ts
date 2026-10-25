import { createSubscriptionCommandExamples, createSubscriptionLifecycleMessages } from "@openlup/platform/subscriptions";
import type { SubscriptionCommandPort, SubscriptionLifecycleMessageDescriptor } from "@openlup/platform/subscriptions/contracts";
import type { TransactionalDeliveryCommand, TransactionalDeliveryReceipt } from "@openlup/platform/communications";

/** Auth and opaque recipient/template binding remain host-owned; M12 keeps account aggregation. */
export function createReferenceSubscriptionFacades(input: {
  commands: SubscriptionCommandPort;
  delivery: {
    send(command: TransactionalDeliveryCommand): Promise<TransactionalDeliveryReceipt>;
    readReceipt(key: string): Promise<TransactionalDeliveryReceipt | null>;
    bind(descriptor: SubscriptionLifecycleMessageDescriptor): Promise<Omit<TransactionalDeliveryCommand, "idempotencyKey">>;
  };
}) {
  const messages = createSubscriptionLifecycleMessages({
    async enqueue(descriptor) {
      const command = { ...await input.delivery.bind(descriptor), idempotencyKey: descriptor.messageKey };
      const prior = await input.delivery.readReceipt(command.idempotencyKey);
      const receipt = await input.delivery.send(command);
      if (receipt.state !== "accepted") throw new Error("subscription_message_delivery_unavailable");
      return { notificationId: receipt.deliveryReference, replayed: prior?.state === "accepted" };
    },
  });
  return { commands: createSubscriptionCommandExamples(input.commands), messages };
}
