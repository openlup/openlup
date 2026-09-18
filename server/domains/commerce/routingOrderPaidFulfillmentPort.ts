// Per-order fulfillment provider routing.
//
// The fulfillment provider is otherwise chosen once per dispatch run from a
// global env (COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER). That is too coarse on
// the hidden preview: flipping the global switch to OmniPack routes EVERY paid
// order — including the synthetic smoke fixtures that carry no delivery
// selection — at the (empty) OmniPack test account, which strands those orders
// with omnipack_order_payload_missing_omnipack_delivery_selection.
//
// Instead, route each order to the provider its customer actually chose at
// checkout. The configurator writes the selected delivery option (carrier +
// service, all providerKind:"omnipack" in our catalog) into the order metadata;
// orders with no selection (synthetic/legacy) fall back to the default provider
// (the simulator on preview). Real configurator orders reach OmniPack; smoke
// fixtures stay on the simulator.

import type {
  OrderPaidFulfillmentPort,
  OrderPaidFulfillmentResult,
} from "./outboxOrderPaidFulfillmentPorts.js";

const MAX_REASON_LENGTH = 300;

export interface OrderFulfillmentProviderKindReader {
  // Normalized providerKind of the order's selected delivery, or null when the
  // order carries no delivery selection.
  readSelectedProviderKind(orderUuid: string): Promise<string | null>;
}

export interface RoutingOrderPaidFulfillmentPortInput {
  reader: OrderFulfillmentProviderKindReader;
  // Ports keyed by the selectedDelivery providerKind that routes to them.
  routes: Partial<Record<string, OrderPaidFulfillmentPort>>;
  // Providers that must never fall back to the default port when selected by an order.
  failClosedProviderKinds?: readonly string[];
  failClosedReasons?: Partial<Record<string, string>>;
  // Used when the order has no selection, or its providerKind has no route.
  fallback: OrderPaidFulfillmentPort;
}

export function createRoutingOrderPaidFulfillmentPort(
  input: RoutingOrderPaidFulfillmentPortInput,
): OrderPaidFulfillmentPort {
  return {
    async ensureFulfilledFromPaidOrder(args): Promise<OrderPaidFulfillmentResult> {
      let providerKind: string | null;
      try {
        providerKind = await input.reader.readSelectedProviderKind(args.orderUuid);
      } catch (error) {
        // A transient read failure must not strand the order on the wrong
        // provider — re-attempt on the next claim rather than silently
        // falling back (which could fulfill an OmniPack order via simulator).
        return {
          kind: "retryable",
          reason: truncate(`routing_provider_read_failed:${errorMessage(error)}`),
        };
      }
      const routed = providerKind ? input.routes[providerKind] : undefined;
      if (routed) return routed.ensureFulfilledFromPaidOrder(args);
      if (providerKind && input.failClosedProviderKinds?.includes(providerKind)) {
        return {
          kind: "snooze",
          reason: truncate(input.failClosedReasons?.[providerKind] ?? `routing_provider_unavailable:${providerKind}`),
        };
      }
      return input.fallback.ensureFulfilledFromPaidOrder(args);
    },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown_error";
}

function truncate(value: string): string {
  return value.length <= MAX_REASON_LENGTH ? value : `${value.slice(0, MAX_REASON_LENGTH)}...`;
}
