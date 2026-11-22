import type { FulfillmentDispatchRequest } from "@openlup/platform/fulfillment/contracts";
import {
  computeStandardWebhookSignature,
  type ShipBobInventoryItem,
  type ShipBobOrderRecord,
} from "../server/index.js";

export const FIXTURE_NOW_ISO = "2030-06-15T12:00:00.000Z";
export const FIXTURE_EARLIER_ISO = "2030-06-15T11:30:00.000Z";
export const FIXTURE_LATER_ISO = "2030-06-15T12:15:00.000Z";
export const FIXTURE_CHANNEL_ID = "987654";

// Constructed programmatically to avoid static secret-scanner false positives while exercising full canary scans.
export const FIXTURE_WEBHOOK_SECRET_PRIMARY =
  "whsec_" + Buffer.from("shipbob-fixture-primary-secret-01", "utf8").toString("base64");
export const FIXTURE_WEBHOOK_SECRET_ROTATED =
  "whsec_" + Buffer.from("shipbob-fixture-rotated-secret-02", "utf8").toString("base64");

export const FIXTURE_SENSITIVE_CANARIES = Object.freeze({
  patToken: ["sb", "pat", "fixture", "canary", "token"].join("_"),
  recipientEmail: ["fixture", "buyer", "canary"].join(".") + "@example.invalid",
  recipientPhone: "+1-555-019-9988",
  recipientStreet: "742 Canary Industrial Pkwy",
  webhookSecretPrimary: FIXTURE_WEBHOOK_SECRET_PRIMARY,
  webhookSecretRotated: FIXTURE_WEBHOOK_SECRET_ROTATED,
  signedTrackingToken: ["signed", "tracking", "token", "canary"].join("_"),
});

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
    requestKey: "req_sb_001",
    fulfillmentRef: "ful_sb_001",
    orderRef: "ord_sb_001",
    orderNumber: "ORD-2030-001",
    parcelRef: "SB-ORD-001",
    contactRevision: { schemaVersion: 1, source: "checkout", revision: 1 },
    recipient: {
      name: "Alex Fixture",
      email: FIXTURE_SENSITIVE_CANARIES.recipientEmail,
      phone: FIXTURE_SENSITIVE_CANARIES.recipientPhone,
      line1: FIXTURE_SENSITIVE_CANARIES.recipientStreet,
      line2: "Suite 400",
      city: "Chicago",
      postalCode: "60607",
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
      providerRef: "shipbob",
      carrierRef: null,
      serviceRef: "Standard",
      deliveryKind: "courier",
      pickupPoint: null,
      ...selectionOverrides,
    },
    ...rest,
  };
}

export function toEpochSecondsString(iso: string): string {
  return String(Math.floor(Date.parse(iso) / 1000));
}

export function buildSignedShipBobWebhookInput(params: {
  readonly webhookId: string;
  readonly topic?: string;
  readonly orderId?: number;
  readonly referenceId?: string;
  readonly orderNumber?: string;
  readonly status: string;
  readonly shipmentStatus?: string;
  readonly shipmentId?: string;
  readonly lastUpdatedAt: string;
  readonly receivedAt?: string;
  readonly headerTimestampIso?: string;
  readonly secretWhsec?: string;
  readonly extraInvalidSignature?: boolean;
  readonly tamperSignature?: boolean;
  readonly tracking?: {
    readonly tracking_number?: string;
    readonly carrier?: string;
    readonly shipping_method?: string;
    readonly tracking_url?: string;
  };
  readonly fulfillmentRef?: string;
  readonly orderRef?: string;
  readonly parcelRef?: string;
}): {
  readonly rawBody: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  readonly receivedAt: string;
} {
  const payload = {
    ...(params.topic ? { topic: params.topic } : {}),
    timestamp: params.lastUpdatedAt,
    data: {
      ...(params.orderId !== undefined ? { id: params.orderId } : {}),
      ...(params.referenceId ? { reference_id: params.referenceId } : {}),
      ...(params.orderNumber ? { order_number: params.orderNumber } : {}),
      status: params.status,
      last_updated_at: params.lastUpdatedAt,
      ...(params.fulfillmentRef ? { fulfillmentRef: params.fulfillmentRef } : {}),
      ...(params.orderRef ? { orderRef: params.orderRef } : {}),
      ...(params.parcelRef ? { parcelRef: params.parcelRef } : {}),
      ...(params.shipmentStatus || params.tracking || params.shipmentId
        ? {
            shipments: [
              {
                ...(params.shipmentId ? { id: params.shipmentId } : {}),
                ...(params.shipmentStatus ? { status: params.shipmentStatus } : {}),
                last_updated_at: params.lastUpdatedAt,
                ...(params.tracking ? { tracking: params.tracking } : {}),
              },
            ],
          }
        : {}),
    },
  };

  const rawBody = new TextEncoder().encode(JSON.stringify(payload));
  const tsSec = toEpochSecondsString(params.headerTimestampIso ?? params.receivedAt ?? FIXTURE_NOW_ISO);
  const secret = params.secretWhsec ?? FIXTURE_WEBHOOK_SECRET_PRIMARY;
  let signature = computeStandardWebhookSignature(params.webhookId, tsSec, rawBody, secret);
  if (params.extraInvalidSignature) {
    signature = `v1,${Buffer.alloc(32, 0).toString("base64")} ${signature}`;
  }
  if (params.tamperSignature) {
    signature = `v1,${Buffer.alloc(32, 0).toString("base64")}`;
  }

  return {
    rawBody,
    headers: {
      "Webhook-Id": params.webhookId,
      "Webhook-Timestamp": tsSec,
      "Webhook-Signature": signature,
      "Content-Type": "application/json",
    },
    receivedAt: params.receivedAt ?? FIXTURE_NOW_ISO,
  };
}

export function buildShipBobOrderPayload(record: ShipBobOrderRecord): Record<string, unknown> {
  return {
    ...(record.id !== null ? { id: record.id } : {}),
    ...(record.reference_id ? { reference_id: record.reference_id } : {}),
    ...(record.order_number ? { order_number: record.order_number } : {}),
    status: record.status,
    created_date: record.created_date ?? FIXTURE_EARLIER_ISO,
    last_updated_at: record.last_updated_at ?? FIXTURE_NOW_ISO,
    shipments: record.shipments ?? [],
  };
}

export function buildShipBobInventoryPayload(
  items: readonly ShipBobInventoryItem[],
): readonly Record<string, unknown>[] {
  return items.map((item, idx) => ({
    id: item.id ?? 5000 + idx,
    sku: item.sku,
    total_on_hand_quantity: item.total_on_hand_quantity,
    total_fulfillable_quantity: item.total_fulfillable_quantity,
    total_committed_quantity: item.total_committed_quantity,
    total_awaiting_quantity: item.total_awaiting_quantity,
    last_updated_date: item.last_updated_date ?? null,
  }));
}
