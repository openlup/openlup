import type { FulfillmentDispatchRequest } from "@openlup/platform/fulfillment/contracts";
import {
  computeAmazonMcfBridgeSignature,
  type AmazonMcfCredentials,
  type AmazonMcfInventorySummary,
  type AmazonMcfOrderRecord,
} from "../server/index.js";

export const FIXTURE_NOW_ISO = "2030-06-15T12:00:00.000Z";
export const FIXTURE_EARLIER_ISO = "2030-06-15T11:30:00.000Z";
export const FIXTURE_LATER_ISO = "2030-06-15T12:15:00.000Z";
export const FIXTURE_MARKETPLACE_US = "ATVPDKIKX0DER";

// Constructed programmatically to avoid static secret-scanner false positives while exercising full canary scans.
export const FIXTURE_WEBHOOK_SECRET_PRIMARY = "a1b2".repeat(16);
export const FIXTURE_WEBHOOK_SECRET_ROTATED = "c3d4".repeat(16);

export const FIXTURE_SENSITIVE_CANARIES = Object.freeze({
  recipientEmail: ["fixture", "buyer", "canary"].join(".") + "@example.invalid",
  recipientPhone: "+1-555-019-9988",
  recipientStreet: "742 Canary Industrial Pkwy",
  lwaClientSecret: ["fixture", "lwa", "client", "secret", "canary"].join("_"),
  lwaRefreshToken: ["fixture", "lwa", "refresh", "token", "canary"].join("_"),
  lwaAccessToken: ["fixture", "lwa", "access", "token", "canary"].join("_"),
  awsSecretAccessKey: ["fixture", "aws", "sigv4", "secret", "canary"].join("_"),
  awsSessionToken: ["fixture", "aws", "sts", "session", "canary"].join("_"),
  webhookSecretPrimary: FIXTURE_WEBHOOK_SECRET_PRIMARY,
  webhookSecretRotated: FIXTURE_WEBHOOK_SECRET_ROTATED,
  signedTrackingToken: ["signed", "tracking", "token", "canary"].join("_"),
});

export function buildFixtureCredentials(): AmazonMcfCredentials {
  return {
    lwaClientId: "amzn1.application-oa2-client.fixture-client",
    lwaClientSecret: FIXTURE_SENSITIVE_CANARIES.lwaClientSecret,
    lwaRefreshToken: FIXTURE_SENSITIVE_CANARIES.lwaRefreshToken,
    accessKeyId: "AKIAFIXTUREMCF000001",
    secretAccessKey: FIXTURE_SENSITIVE_CANARIES.awsSecretAccessKey,
    sessionToken: FIXTURE_SENSITIVE_CANARIES.awsSessionToken,
  };
}

export function buildLwaTokenResponse(accessToken = FIXTURE_SENSITIVE_CANARIES.lwaAccessToken): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 3600,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

export function approveFixtureTrackingUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "track.carrier.example";
  } catch {
    return false;
  }
}

export function buildDispatchRequest(
  overrides: Partial<FulfillmentDispatchRequest> & {
    readonly recipientOverrides?: Partial<FulfillmentDispatchRequest["recipient"]>;
    readonly selectionOverrides?: Partial<FulfillmentDispatchRequest["selection"]>;
  } = {},
): FulfillmentDispatchRequest {
  const { recipientOverrides, selectionOverrides, ...rest } = overrides;
  return {
    requestKey: "req_mcf_001",
    fulfillmentRef: "ful_mcf_001",
    orderRef: "ord_mcf_001",
    orderNumber: "ORD-2030-001",
    parcelRef: "MCF-ORD-001",
    contactRevision: { schemaVersion: 1, source: "checkout", revision: 1 },
    recipient: {
      name: "Alex Fixture",
      email: FIXTURE_SENSITIVE_CANARIES.recipientEmail,
      phone: FIXTURE_SENSITIVE_CANARIES.recipientPhone,
      line1: FIXTURE_SENSITIVE_CANARIES.recipientStreet,
      line2: "Suite 400",
      city: "Seattle",
      postalCode: "98109",
      country: "US",
      deliveryInstructions: "Leave at loading dock",
      courierInstructions: null,
      ...recipientOverrides,
    },
    lines: [
      {
        skuRef: "SKU-WIDGET-01",
        title: "Widget Pack",
        quantity: 2,
        productRef: "prod_001",
        packRef: null,
        lotRef: "LOT-2030-A",
        expirationDate: "2031-12-31",
      },
    ],
    selection: {
      providerRef: "amazon_mcf",
      carrierRef: null,
      serviceRef: "mcf_standard",
      deliveryKind: "courier",
      pickupPoint: null,
      ...selectionOverrides,
    },
    ...rest,
  };
}

export function buildSignedNotificationInput(params: {
  readonly sellerFulfillmentOrderId: string;
  readonly fulfillmentOrderStatus: string;
  readonly fulfillmentShipmentStatus?: string;
  readonly statusUpdatedDateTime: string;
  readonly receivedAt?: string;
  readonly notificationId: string;
  readonly displayableOrderId?: string;
  readonly fulfillmentRef?: string;
  readonly orderRef?: string;
  readonly parcelRef?: string;
  readonly amazonShipmentId?: string;
  readonly packages?: readonly {
    readonly trackingNumber?: string;
    readonly carrierCode?: string;
    readonly trackingUrl?: string;
  }[];
  readonly timestamp?: string;
  readonly secretHex?: string;
  readonly notificationType?: string;
  readonly tamperSignature?: boolean;
}): {
  readonly rawBody: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  readonly receivedAt: string;
} {
  const payload = {
    notificationVersion: "1.0",
    notificationType: params.notificationType ?? "FULFILLMENT_ORDER_STATUS",
    payloadVersion: "1.0",
    eventTime: params.statusUpdatedDateTime,
    notificationMetadata: {
      applicationId: "amzn1.sellerapps.app.fixture",
      subscriptionId: "sub-fixture-001",
      publishTime: params.statusUpdatedDateTime,
      notificationId: params.notificationId,
    },
    payload: {
      fulfillmentOrderStatusNotification: {
        sellerId: "A1FIXTURESELLER",
        eventType: "Order",
        status: params.fulfillmentOrderStatus,
        sellerFulfillmentOrderId: params.sellerFulfillmentOrderId,
        fulfillmentOrderStatus: params.fulfillmentOrderStatus,
        ...(params.fulfillmentShipmentStatus
          ? { fulfillmentShipmentStatus: params.fulfillmentShipmentStatus }
          : {}),
        statusUpdatedDateTime: params.statusUpdatedDateTime,
        ...(params.displayableOrderId ? { displayableOrderId: params.displayableOrderId } : {}),
        ...(params.fulfillmentRef ? { fulfillmentRef: params.fulfillmentRef } : {}),
        ...(params.orderRef ? { orderRef: params.orderRef } : {}),
        ...(params.parcelRef ? { parcelRef: params.parcelRef } : {}),
        ...(params.amazonShipmentId ? { amazonShipmentId: params.amazonShipmentId } : {}),
        ...(params.packages ? { fulfillmentShipmentPackages: params.packages } : {}),
      },
    },
  };

  const rawBody = new TextEncoder().encode(JSON.stringify(payload));
  const timestamp = params.timestamp ?? params.receivedAt ?? FIXTURE_NOW_ISO;
  const secretHex = params.secretHex ?? FIXTURE_WEBHOOK_SECRET_PRIMARY;
  let signature = computeAmazonMcfBridgeSignature(timestamp, rawBody, secretHex);
  if (params.tamperSignature) {
    signature = `sha256=${"0".repeat(64)}`;
  }

  return {
    rawBody,
    headers: {
      "x-mcf-timestamp": timestamp,
      "x-mcf-signature": signature,
      "content-type": "application/json",
    },
    receivedAt: params.receivedAt ?? FIXTURE_NOW_ISO,
  };
}

export function buildSpApiOrderPayload(record: AmazonMcfOrderRecord): Record<string, unknown> {
  return {
    payload: {
      fulfillmentOrder: {
        sellerFulfillmentOrderId: record.sellerFulfillmentOrderId,
        marketplaceId: record.marketplaceId ?? FIXTURE_MARKETPLACE_US,
        displayableOrderId: record.displayableOrderId ?? record.sellerFulfillmentOrderId,
        fulfillmentOrderStatus: record.fulfillmentOrderStatus,
        statusUpdatedDate: record.statusUpdatedDate ?? FIXTURE_NOW_ISO,
        receivedDate: record.receivedDate ?? FIXTURE_EARLIER_ISO,
      },
      fulfillmentShipments: record.fulfillmentShipments ?? [],
    },
  };
}

export function buildSpApiInventoryPayload(
  summaries: readonly AmazonMcfInventorySummary[],
  nextToken: string | null = null,
): Record<string, unknown> {
  return {
    payload: {
      granularity: {
        granularityType: "Marketplace",
        granularityId: FIXTURE_MARKETPLACE_US,
      },
      inventorySummaries: summaries.map((item) => ({
        sellerSku: item.sellerSku,
        fnSku: item.fnSku ?? "X00FIXTURE01",
        asin: item.asin ?? "B0FIXTURE01",
        totalQuantity: item.totalQuantity,
        lastUpdatedTime: item.lastUpdatedTime ?? FIXTURE_NOW_ISO,
        inventoryDetails: {
          fulfillableQuantity: item.fulfillableQuantity,
          reservedQuantity: { totalReservedQuantity: item.reservedQuantity },
          unfulfillableQuantity: { totalUnfulfillableQuantity: item.unfulfillableQuantity },
        },
      })),
    },
    ...(nextToken ? { pagination: { nextToken } } : {}),
  };
}
