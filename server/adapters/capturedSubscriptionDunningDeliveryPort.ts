import type {
  DunningDeliveryPort,
  DunningDeliveryRequest,
  SubscriptionRuntimeClock,
} from "../../src/domains/subscription/ports.js";
import {
  type DunningEmailPort,
  type DunningPaymentExpiredEmailInput,
  type DunningPaymentFailedEmailInput,
} from "../domains/subscription/subscriptionDunningDispatchPorts.js";
import {
  dunningEmailOutcomeFromDelivery,
  type DunningEmailSendOutcome,
} from "../domains/subscription/dunningDeliveryOutcome.js";

type ProductDunningInput =
  | DunningPaymentFailedEmailInput
  | DunningPaymentExpiredEmailInput;

interface CapturedDunningLedgerClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export function createCapturedSubscriptionDunningDeliveryPort(input: {
  client: CapturedDunningLedgerClient;
  clock: SubscriptionRuntimeClock;
}): DunningDeliveryPort {
  return {
    async deliver(request, signal) {
      if (signal.aborted) {
        return rejected("aborted", true);
      }

      const deliveryId = `captured:${request.notificationId}`;
      const { error } = await input.client.rpc(
        "subscription_dunning_record_email_attempt",
        {
          p_template_slug: request.templateKey,
          p_notification_id: request.notificationId,
          p_resend_id: deliveryId,
          p_status: "sent",
          p_sent_at: input.clock.now().toISOString(),
          p_provider_error: null,
          p_provider_response: {
            adapter: "captured",
            correlationId: request.correlationId,
            deliveryKind: request.kind,
            attempt: request.attempt,
            notificationId: request.notificationId,
          },
        },
      );
      if (error) {
        throw new Error(
          `captured_dunning_delivery_write_failed: ${error.message ?? error.code ?? "unknown"}`,
        );
      }

      return {
        accepted: true,
        deliveryId,
        retryable: false,
        errorCode: null,
      };
    },
  };
}

/**
 * Local/reference bridge only. The existing product-overlay mail adapter and
 * renderer remain unchanged. Recovery URLs may arrive on that owned contract,
 * but this bridge deliberately never forwards or persists them.
 */
export function createCapturedSubscriptionDunningEmailPort(
  deliveryPort: DunningDeliveryPort,
): DunningEmailPort {
  return {
    sendPaymentFailed(input) {
      return deliver(deliveryPort, "payment_failed", input.retryAttempt, input);
    },
    sendPaymentExpired(input) {
      return deliver(deliveryPort, "payment_expired", 1, input);
    },
  };
}

async function deliver(
  port: DunningDeliveryPort,
  kind: DunningDeliveryRequest["kind"],
  attempt: number,
  input: ProductDunningInput,
): Promise<DunningEmailSendOutcome> {
  const outcome = await port.deliver(
    {
      notificationId: input.notificationId,
      correlationId: input.notificationId,
      kind,
      templateKey: input.templateSlug,
      attempt,
      recipient: { channel: "email", address: input.to },
    },
    input.signal,
  );
  return dunningEmailOutcomeFromDelivery(outcome);
}

function rejected(errorCode: string, retryable: boolean) {
  return {
    accepted: false,
    deliveryId: null,
    retryable,
    errorCode,
  };
}
