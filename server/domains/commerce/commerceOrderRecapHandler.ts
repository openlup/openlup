import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  ORDER_RECAP_CONTRACT_VERSION,
  ORDER_RECAP_V3_CONTRACT_VERSION,
  ORDER_RECAP_V4_CONTRACT_VERSION,
  orderRecapRequestSchema,
  orderRecapResponseSchema,
  orderRecapV3ResponseSchema,
  orderRecapV4ResponseSchema,
  type OrderRecapV4Response,
  type OrderRecapResponse,
  type OrderRecapV3Response,
} from "../../../src/domains/commerce/orderRecapContracts.js";

/** Internal recap superset assembled by the existing ownership-guarded read. */
export type OrderRecapData = Omit<OrderRecapResponse, "contractVersion" | "items"> & {
  checkoutKind: OrderRecapV3Response["checkoutKind"];
  moneyReconciled: boolean;
  items: OrderRecapV3Response["items"];
  firstSubscriptionPricePresentation: OrderRecapV4Response["firstSubscriptionPricePresentation"];
};

export interface OrderRecapReadPort {
  /**
   * Returns the recap for `orderId` ONLY when it is owned by `clientId`.
   * A non-owning (or unknown) pair resolves to `null` — the handler maps that
   * to a 404 so existence is never leaked across clients.
   */
  getOrderRecap(input: {
    orderId: string;
    clientId: string;
  }): Promise<OrderRecapData | null>;
}

export interface CommerceOrderRecapHandlerDeps {
  recapPort: OrderRecapReadPort;
  mutationsEnabled: () => boolean;
}

export function createCommerceOrderRecapHandler({
  recapPort,
  mutationsEnabled,
}: CommerceOrderRecapHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }
    if (!mutationsEnabled()) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Order recap is disabled", {
        details: {
          feature: "order-recap",
          featureFlag: "COMMERCE_PROVIDER_PAYMENTS_ENABLED",
          reason: "feature_flag_disabled",
        },
      });
      return;
    }

    const parsed = orderRecapRequestSchema.safeParse(normalizeQuery(req.query));
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid order recap request", {
        details: parsed.error.flatten(),
      });
      return;
    }

    const recap = await recapPort.getOrderRecap({
      orderId: parsed.data.orderId,
      clientId: parsed.data.clientId,
    });
    if (!recap) {
      sendBffError(res, "NOT_FOUND", "Order recap not found");
      return;
    }

    if (parsed.data.contractVersion === ORDER_RECAP_V3_CONTRACT_VERSION) {
      const response = orderRecapV3ResponseSchema.parse({
        contractVersion: ORDER_RECAP_V3_CONTRACT_VERSION,
        ...projectCommonRecap(recap),
        checkoutKind: recap.checkoutKind,
        moneyReconciled: recap.moneyReconciled,
        items: recap.items,
      });
      sendBffSuccess(res, response, { contractVersion: ORDER_RECAP_V3_CONTRACT_VERSION });
      return;
    }

    if (parsed.data.contractVersion === ORDER_RECAP_V4_CONTRACT_VERSION) {
      const response = orderRecapV4ResponseSchema.parse({
        contractVersion: ORDER_RECAP_V4_CONTRACT_VERSION,
        ...projectCommonRecap(recap),
        checkoutKind: recap.checkoutKind,
        moneyReconciled: recap.moneyReconciled,
        items: recap.items,
        firstSubscriptionPricePresentation: recap.firstSubscriptionPricePresentation,
      });
      sendBffSuccess(res, response, { contractVersion: ORDER_RECAP_V4_CONTRACT_VERSION });
      return;
    }

    const response = orderRecapResponseSchema.parse({
      contractVersion: ORDER_RECAP_CONTRACT_VERSION,
      ...projectCommonRecap(recap),
      items: recap.items.map(projectV2Line),
    });
    sendBffSuccess(res, response, { contractVersion: ORDER_RECAP_CONTRACT_VERSION });
  };
}

function projectCommonRecap(
  recap: OrderRecapData,
): Omit<OrderRecapResponse, "contractVersion" | "items"> {
  return {
    orderId: recap.orderId,
    orderRef: recap.orderRef,
    orderNumber: recap.orderNumber,
    status: recap.status,
    paymentStatus: recap.paymentStatus,
    mode: recap.mode,
    petId: recap.petId,
    petName: recap.petName,
    customerFirstName: recap.customerFirstName,
    maskedEmail: recap.maskedEmail,
    cadenceDays: recap.cadenceDays,
    nextDeliveryAt: recap.nextDeliveryAt,
    totals: recap.totals,
    shippingAddress: recap.shippingAddress,
    createdAt: recap.createdAt,
  };
}

function projectV2Line(
  item: OrderRecapData["items"][number],
): OrderRecapResponse["items"][number] {
  return {
    title: item.title,
    quantity: item.quantity,
    recipeName: item.recipeName,
    variantName: item.variantName,
    total: item.total,
    listTotal: item.listTotal,
    discount: item.discount,
  };
}

function normalizeQuery(query: VercelRequest["query"]): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    normalized[key] = Array.isArray(value) ? value[0] : value;
  }
  return normalized;
}
