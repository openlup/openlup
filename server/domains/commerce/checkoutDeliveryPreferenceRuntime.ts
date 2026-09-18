import type { CommerceCheckoutRuntimePort } from "../../../src/domains/commerce/runtimePorts.js";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import {
  type CheckoutDeliveryPreferenceStore,
  upsertCheckoutDeliveryPreferencesBestEffort,
} from "./checkoutDeliveryPreferences.js";

type StartRuntimeRequest = Parameters<CommerceCheckoutRuntimePort["startRuntime"]>[0];

export function withCheckoutDeliveryPreferenceRuntime(
  runtimePort: CommerceCheckoutRuntimePort,
  store: CheckoutDeliveryPreferenceStore,
): CommerceCheckoutRuntimePort {
  return {
    async startRuntime(request) {
      const response = await runtimePort.startRuntime(request);
      await upsertCheckoutDeliveryPreferencesBestEffort({
        store,
        clientId: request.clientId,
        checkoutKind: request.saveForFutureUse ? "subscription_initial" : "one_time",
        selectedDelivery: readSelectedDelivery(request.metadata),
      });
      return response;
    },
    applyPaymentResult: (request) => runtimePort.applyPaymentResult(request),
  };
}

function readSelectedDelivery(
  metadata: StartRuntimeRequest["metadata"],
): ConfiguratorIntent["selectedDelivery"] | null {
  const direct = record(metadata.selectedDelivery);
  if (direct) return direct as ConfiguratorIntent["selectedDelivery"];
  const runtimeFinalize = record(metadata.runtimeFinalize);
  return (record(runtimeFinalize?.selectedDelivery) as ConfiguratorIntent["selectedDelivery"] | null) ?? null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
