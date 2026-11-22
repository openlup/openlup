import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  CanonicalLocalFulfillmentStatus,
  FulfillmentObservation,
  FulfillmentObservationCodecs,
  FulfillmentObservationPort,
  FulfillmentTrackingReference,
} from "@openlup/platform/fulfillment/contracts";

export const AMAZON_MCF_PROVIDER_REF = "amazon_mcf" as const;
export const AMAZON_MCF_MAPPER_VERSION = "amazon-mcf-spapi-v2020-07-01" as const;

const MIN_HMAC_KEY_HEX_LEN = 32;
const HEX_64_REGEX = /^[0-9a-f]{64}$/u;
const SAFE_REF_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RFC3339_OFFSET_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

export interface AmazonMcfWebhookVerifierOptions {
  /** One or more hex-encoded HMAC-SHA256 signing secrets (min 32 hex chars each) for key rotation. */
  readonly signingSecrets: readonly string[];
  /** Optional carrier tracking URL approval predicate matching host policy. */
  readonly approveTrackingUrl?: (url: string) => boolean;
  /** Optional explicit observation codecs matching host policy. */
  readonly observationCodecs?: FulfillmentObservationCodecs;
  /** Optional maximum timestamp skew in milliseconds for replay protection (disabled when omitted). */
  readonly maxTimestampSkewMs?: number;
}

export interface MappedAmazonMcfStatus {
  readonly canonicalStatus: CanonicalLocalFulfillmentStatus;
  readonly eventKind: FulfillmentObservation["eventKind"];
  readonly recovery: "provider_recovered" | "delivery_only" | "manual" | null;
}

export function deterministicEvidenceReference(digestHex: string): `evidence:${string}` {
  const hex = digestHex.slice(0, 32).padEnd(32, "0");
  const p1 = hex.slice(0, 8);
  const p2 = hex.slice(8, 12);
  // Set version nibble to 5 and RFC 4122 variant bits to 10xx (8..b)
  const p3 = `5${hex.slice(13, 16)}`;
  const variantNibble = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  const p4 = `${variantNibble}${hex.slice(17, 20)}`;
  const p5 = hex.slice(20, 32);
  return `evidence:${p1}-${p2}-${p3}-${p4}-${p5}`;
}

export function mapAmazonMcfStatus(
  orderStatusRaw: string | null | undefined,
  shipmentStatusRaw?: string | null,
): MappedAmazonMcfStatus | null {
  const shipment = typeof shipmentStatusRaw === "string" ? shipmentStatusRaw.trim().toUpperCase() : "";
  const order = typeof orderStatusRaw === "string" ? orderStatusRaw.trim().toUpperCase() : "";

  // 1. Order-level exceptions & cancellations always take precedence over partial shipment delivery/transit.
  switch (order) {
    case "UNFULFILLABLE":
    case "INVALID":
    case "COMPLETEPARTIALLED":
    case "COMPLETE_PARTIALLED":
      return { canonicalStatus: "exception", eventKind: "parcel.exception", recovery: "manual" };
    case "UNDELIVERABLE":
    case "DELIVERYATTEMPTED":
    case "DELIVERY_ATTEMPTED":
      return { canonicalStatus: "exception", eventKind: "parcel.exception", recovery: "delivery_only" };
    case "CANCELLED":
    case "CANCELED":
      return { canonicalStatus: "cancelled", eventKind: "parcel.cancelled", recovery: null };
    default:
      break;
  }

  // 2. Shipment-level exceptions & cancellations take precedence over normal transit/delivery.
  if (shipment === "RETURNED_TO_SELLER" || shipment === "RETURNED") {
    return { canonicalStatus: "exception", eventKind: "parcel.exception", recovery: "manual" };
  }
  if (shipment === "UNDELIVERABLE" || shipment === "DELIVERY_ATTEMPTED" || shipment === "LOST") {
    return { canonicalStatus: "exception", eventKind: "parcel.exception", recovery: "delivery_only" };
  }
  if (shipment === "CANCELLED_BY_FULFILLER" || shipment === "CANCELLED_BY_SELLER") {
    return { canonicalStatus: "cancelled", eventKind: "parcel.cancelled", recovery: null };
  }

  // 3. Normal shipment progress.
  if (shipment === "DELIVERED") {
    return { canonicalStatus: "delivered", eventKind: "order.delivered", recovery: null };
  }
  if (shipment === "SHIPPED" || shipment === "IN_TRANSIT" || shipment === "OUT_FOR_DELIVERY") {
    return { canonicalStatus: "in_transit", eventKind: "order.shipped", recovery: null };
  }

  // 4. Order-level lifecycle fallback.
  switch (order) {
    case "NEW":
    case "RECEIVED":
      return { canonicalStatus: "provider_received", eventKind: "order.processing_started", recovery: null };
    case "PLANNING":
      return { canonicalStatus: "picking", eventKind: "order.processing_started", recovery: null };
    case "PROCESSING":
      return { canonicalStatus: "packed", eventKind: "order.picked", recovery: null };
    case "COMPLETE":
      return { canonicalStatus: "delivered", eventKind: "order.delivered", recovery: null };
    default:
      return null;
  }
}

const SHIPMENT_STATUS_PRECEDENCE: readonly string[] = [
  "RETURNED_TO_SELLER",
  "RETURNED",
  "UNDELIVERABLE",
  "DELIVERY_ATTEMPTED",
  "LOST",
  "CANCELLED_BY_FULFILLER",
  "CANCELLED_BY_SELLER",
  "DELIVERED",
  "OUT_FOR_DELIVERY",
  "IN_TRANSIT",
  "SHIPPED",
];

/**
 * Inspect all fulfillment shipments for an order and pick the highest-precedence
 * shipment status so an exception or cancellation on an earlier shipment is never
 * masked by a later shipment.
 */
export function resolveAmazonMcfAggregateShipmentStatus(
  shipments: readonly { readonly fulfillmentShipmentStatus?: string | null }[] | undefined,
): string | null {
  if (!shipments || shipments.length === 0) return null;
  let bestStatus: string | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const shipment of shipments) {
    const raw = typeof shipment.fulfillmentShipmentStatus === "string"
      ? shipment.fulfillmentShipmentStatus.trim()
      : "";
    if (!raw) continue;
    const upper = raw.toUpperCase();
    const rank = SHIPMENT_STATUS_PRECEDENCE.indexOf(upper);
    const effectiveRank = rank >= 0 ? rank : SHIPMENT_STATUS_PRECEDENCE.length;
    if (effectiveRank < bestRank) {
      bestRank = effectiveRank;
      bestStatus = raw;
    }
  }
  return bestStatus;
}

function getHeaderInsensitive(headers: Readonly<Record<string, string>>, target: string): string | null {
  const lowerTarget = target.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerTarget) {
      return value;
    }
  }
  return null;
}

function parseHexSecret(secret: string): Buffer | null {
  const trimmed = secret.trim();
  if (trimmed.length < MIN_HMAC_KEY_HEX_LEN || trimmed.length % 2 !== 0 || !/^[0-9a-fA-F]+$/u.test(trimmed)) {
    return null;
  }
  return Buffer.from(trimmed, "hex");
}

/**
 * Compute the canonical HMAC-SHA256 bridge signature over `${timestamp}.${rawBody}` UTF-8 bytes.
 * Format: `sha256=<64-lowercase-hex>`.
 */
export function computeAmazonMcfBridgeSignature(
  timestamp: string,
  rawBody: Uint8Array,
  secretHex: string,
): string {
  const key = parseHexSecret(secretHex);
  if (!key) {
    throw new Error("amazon_mcf_webhook_signing_secret_invalid");
  }
  const prefix = Buffer.from(`${timestamp}.`, "utf8");
  const mac = createHmac("sha256", key).update(prefix).update(rawBody).digest("hex");
  return `sha256=${mac}`;
}

function timingSafeHexEqual(expectedHex: string, actualHex: string): boolean {
  if (!HEX_64_REGEX.test(expectedHex) || !HEX_64_REGEX.test(actualHex)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(actualHex, "hex"));
}

function isValidRfc3339(value: unknown): value is string {
  return typeof value === "string" && RFC3339_OFFSET_REGEX.test(value) && Number.isFinite(Date.parse(value));
}

function safeRef(value: unknown, approveReference?: (v: string) => boolean): string | null {
  if (typeof value !== "string") return null;
  if (/[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || /[@]|[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) return null;
  const admitted = approveReference ? approveReference(trimmed) : SAFE_REF_REGEX.test(trimmed);
  return admitted ? trimmed : null;
}

export function sanitizeTrackingUrl(
  rawUrl: string | null | undefined,
  approveTrackingUrl?: (url: string) => boolean,
  codec?: (url: string) => string | null,
): { readonly url: string | null; readonly rejected: boolean } {
  if (rawUrl == null || rawUrl === "") {
    return { url: null, rejected: false };
  }
  try {
    const candidate = codec ? codec(rawUrl) : rawUrl;
    if (!candidate) return { url: null, rejected: true };
    const parsed = new URL(candidate);
    const allowed =
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      (Boolean(codec) || (!parsed.search && !parsed.hash)) &&
      Boolean(approveTrackingUrl?.(parsed.href));
    return allowed ? { url: parsed.href, rejected: false } : { url: null, rejected: true };
  } catch {
    return { url: null, rejected: true };
  }
}

export function buildNormalizedTrackingRefs(input: {
  readonly rawTracking: readonly {
    readonly trackingNumber?: unknown;
    readonly carrierCode?: unknown;
    readonly serviceRef?: unknown;
    readonly trackingUrl?: unknown;
  }[];
  readonly approveTrackingUrl?: (url: string) => boolean;
  readonly codecs?: FulfillmentObservationCodecs;
}): {
  readonly trackingRefs: readonly FulfillmentTrackingReference[];
  readonly rejectedTrackingRefs: number;
  readonly rejectedTrackingUrls: number;
  readonly redactedFieldCount: number;
} {
  const trackingRefs: FulfillmentTrackingReference[] = [];
  let rejectedTrackingRefs = 0;
  let rejectedTrackingUrls = 0;
  let redactedFieldCount = 0;

  for (const item of input.rawTracking) {
    const rawNum = item.trackingNumber;
    if (rawNum == null) continue;
    const trackingNumber = safeRef(rawNum, input.codecs?.approveReference);
    if (!trackingNumber) {
      rejectedTrackingRefs += 1;
      redactedFieldCount += 1;
      continue;
    }

    let serviceRef: string | null = null;
    if (item.serviceRef != null) {
      serviceRef = safeRef(item.serviceRef, input.codecs?.approveReference);
      if (serviceRef === null) redactedFieldCount += 1;
    }

    let carrierRef: string | null = null;
    if (item.carrierCode != null) {
      // Strictly validate opaque carrier token without laundering freeform PII/emails/spaces.
      const rawCarrier = typeof item.carrierCode === "string" ? item.carrierCode.trim() : "";
      const hasUnsafePattern =
        !rawCarrier ||
        /[\p{Cc}\p{Cf}\s@]/u.test(rawCarrier) ||
        /[a-z][a-z0-9+.-]*:\/\//iu.test(rawCarrier);
      const lowered = hasUnsafePattern ? "" : rawCarrier.toLowerCase();
      const admittedCarrier =
        item.serviceRef != null && serviceRef === null
          ? null
          : lowered && SAFE_REF_REGEX.test(lowered)
            ? lowered
            : null;
      if (admittedCarrier === null) {
        redactedFieldCount += 1;
      } else {
        carrierRef = admittedCarrier;
      }
    }

    const urlCheck = sanitizeTrackingUrl(
      typeof item.trackingUrl === "string" ? item.trackingUrl : null,
      input.approveTrackingUrl,
      input.codecs?.trackingUrl,
    );
    if (urlCheck.rejected) {
      rejectedTrackingUrls += 1;
      redactedFieldCount += 1;
    }

    trackingRefs.push({
      trackingNumber,
      carrierRef,
      serviceRef,
      publicUrl: urlCheck.url,
    });
  }

  return {
    trackingRefs,
    rejectedTrackingRefs,
    rejectedTrackingUrls,
    redactedFieldCount,
  };
}

/**
 * Create an auth-before-parse `FulfillmentObservationPort` for bridged Amazon SP-API
 * `FULFILLMENT_ORDER_STATUS` notifications.
 */
export function createAmazonMcfWebhookVerifier(
  options: AmazonMcfWebhookVerifierOptions,
): FulfillmentObservationPort {
  const parsedKeys = options.signingSecrets
    .map((secret) => parseHexSecret(secret))
    .filter((key): key is Buffer => key !== null);

  if (parsedKeys.length === 0 || parsedKeys.length !== options.signingSecrets.length) {
    throw new Error("amazon_mcf_webhook_signing_secret_invalid");
  }
  if (
    options.maxTimestampSkewMs !== undefined &&
    (!Number.isFinite(options.maxTimestampSkewMs) || options.maxTimestampSkewMs < 0)
  ) {
    throw new Error("amazon_mcf_webhook_max_skew_invalid");
  }

  return {
    async verifyAndNormalize(input) {
      // 1. Auth-before-parse: verify timestamp + canonical HMAC over untouched rawBody bytes.
      const timestamp = getHeaderInsensitive(input.headers, "x-mcf-timestamp")?.trim() ?? "";
      const signatureHeader = getHeaderInsensitive(input.headers, "x-mcf-signature")?.trim() ?? "";

      if (!timestamp || !isValidRfc3339(timestamp) || !signatureHeader.startsWith("sha256=")) {
        return {
          kind: "refused",
          refusal: { reason: "untrusted", phase: "verify", retryable: false },
        };
      }

      if (options.maxTimestampSkewMs !== undefined && isValidRfc3339(input.receivedAt)) {
        const skew = Math.abs(Date.parse(input.receivedAt) - Date.parse(timestamp));
        if (skew > options.maxTimestampSkewMs) {
          return {
            kind: "refused",
            refusal: { reason: "untrusted", phase: "verify", retryable: false },
          };
        }
      }

      const providedHex = signatureHeader.slice("sha256=".length).toLowerCase();
      const prefix = Buffer.from(`${timestamp}.`, "utf8");
      const authentic = parsedKeys.some((key) => {
        const expectedHex = createHmac("sha256", key).update(prefix).update(input.rawBody).digest("hex");
        return timingSafeHexEqual(expectedHex, providedHex);
      });

      if (!authentic) {
        return {
          kind: "refused",
          refusal: { reason: "untrusted", phase: "verify", retryable: false },
        };
      }

      // 2. Parse only after authentication succeeded.
      if (!isValidRfc3339(input.receivedAt)) {
        return {
          kind: "refused",
          refusal: { reason: "malformed", phase: "normalize", retryable: false },
          diagnostics: { invalidTimestamp: true },
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(input.rawBody));
      } catch {
        return {
          kind: "refused",
          refusal: { reason: "malformed", phase: "normalize", retryable: false },
        };
      }

      if (!parsed || typeof parsed !== "object") {
        return {
          kind: "refused",
          refusal: { reason: "malformed", phase: "normalize", retryable: false },
        };
      }

      const envelope = parsed as Record<string, unknown>;
      if (envelope["notificationType"] !== "FULFILLMENT_ORDER_STATUS") {
        return {
          kind: "refused",
          refusal: { reason: "unsupported_event", phase: "normalize", retryable: false },
        };
      }

      const payloadRoot = (envelope["payload"] && typeof envelope["payload"] === "object"
        ? envelope["payload"]
        : {}) as Record<string, unknown>;
      const statusNotification = (payloadRoot["fulfillmentOrderStatusNotification"] &&
      typeof payloadRoot["fulfillmentOrderStatusNotification"] === "object"
        ? payloadRoot["fulfillmentOrderStatusNotification"]
        : payloadRoot) as Record<string, unknown>;

      const sellerOrderId = safeRef(
        statusNotification["sellerFulfillmentOrderId"],
        options.observationCodecs?.approveReference,
      );
      if (!sellerOrderId) {
        return {
          kind: "refused",
          refusal: { reason: "missing_correlation", phase: "normalize", retryable: false },
          diagnostics: { rejectedCorrelationRefs: 1 },
        };
      }

      const orderStatus =
        typeof statusNotification["fulfillmentOrderStatus"] === "string"
          ? statusNotification["fulfillmentOrderStatus"].trim()
          : "";
      const shipmentStatus =
        typeof statusNotification["fulfillmentShipmentStatus"] === "string"
          ? statusNotification["fulfillmentShipmentStatus"].trim()
          : null;

      const mapped = mapAmazonMcfStatus(orderStatus, shipmentStatus);
      if (!mapped) {
        return {
          kind: "refused",
          refusal: { reason: "unsupported_event", phase: "normalize", retryable: false },
        };
      }

      const occurredAtRaw =
        statusNotification["statusUpdatedDateTime"] ??
        statusNotification["eventTime"] ??
        envelope["eventTime"];
      if (!isValidRfc3339(occurredAtRaw)) {
        return {
          kind: "refused",
          refusal: { reason: "malformed", phase: "normalize", retryable: false },
          diagnostics: { invalidTimestamp: true },
        };
      }
      const occurredAt = new Date(Date.parse(occurredAtRaw)).toISOString();
      const receivedAt = new Date(Date.parse(input.receivedAt)).toISOString();

      const notificationMetadata = (envelope["notificationMetadata"] &&
      typeof envelope["notificationMetadata"] === "object"
        ? envelope["notificationMetadata"]
        : {}) as Record<string, unknown>;
      const notificationId = safeRef(notificationMetadata["notificationId"]);

      const digest = createHash("sha256").update(input.rawBody).digest("hex");
      const rawRef = deterministicEvidenceReference(digest);

      const occurrenceKey =
        notificationId ??
        `mcf_${createHash("sha256")
          .update(`${sellerOrderId}|${mapped.canonicalStatus}|${occurredAt}`)
          .digest("hex")
          .slice(0, 24)}`;

      const eventKey = `amazon_mcf:${sellerOrderId}:${mapped.eventKind}:${mapped.canonicalStatus}:${occurredAt}:${occurrenceKey}`;
      const factId = `mcf_fact_${createHash("sha256").update(eventKey).digest("hex").slice(0, 24)}`;

      const rawPackages = Array.isArray(statusNotification["fulfillmentShipmentPackages"])
        ? statusNotification["fulfillmentShipmentPackages"]
        : [];
      const tracking = buildNormalizedTrackingRefs({
        rawTracking: rawPackages.filter(
          (entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"),
        ),
        approveTrackingUrl: options.approveTrackingUrl,
        codecs: options.observationCodecs,
      });

      const orderNumber = safeRef(
        statusNotification["displayableOrderId"],
        options.observationCodecs?.approveReference,
      );
      const fulfillmentRef = safeRef(
        statusNotification["fulfillmentRef"],
        options.observationCodecs?.approveReference,
      );
      const orderRef = safeRef(statusNotification["orderRef"], options.observationCodecs?.approveReference);
      const parcelRef = safeRef(statusNotification["parcelRef"], options.observationCodecs?.approveReference);
      const providerFulfillmentRef =
        safeRef(statusNotification["amazonShipmentId"], options.observationCodecs?.approveReference) ??
        sellerOrderId;

      const primaryStatus = safeRef(orderStatus) ?? null;
      const subStatus = safeRef(shipmentStatus) ?? null;

      const hasAdmission = tracking.rejectedTrackingRefs > 0 || tracking.rejectedTrackingUrls > 0;
      const diagnostics: NonNullable<FulfillmentObservation["diagnostics"]> = {};
      if (hasAdmission) {
        diagnostics.admission = {
          rejectedTrackingRefs: tracking.rejectedTrackingRefs,
          rejectedTrackingUrls: tracking.rejectedTrackingUrls,
        };
      }
      if (tracking.redactedFieldCount > 0) {
        diagnostics.redactedFieldCount = tracking.redactedFieldCount;
      }

      const observation: FulfillmentObservation = {
        eventKey,
        correlation: {
          orderRef,
          fulfillmentRef,
          externalRef: sellerOrderId,
          orderNumber,
          providerFulfillmentRef,
          parcelRef,
        },
        providerStatus: {
          primary: primaryStatus,
          subStatus,
        },
        fact: {
          schemaVersion: 1,
          mapperVersion: AMAZON_MCF_MAPPER_VERSION,
          factId,
          providerKind: AMAZON_MCF_PROVIDER_REF,
          fulfillmentReference: sellerOrderId,
          canonicalStatus: mapped.canonicalStatus,
          provenance: {
            source: "provider_webhook",
            authority: "provider_asserted",
          },
          occurredAt,
          receivedAt,
          rawEvent: {
            reference: rawRef,
            digestAlgorithm: "sha256",
            digest,
          },
        },
        eventKind: mapped.eventKind,
        firstReceivedAt: receivedAt,
        trackingRefs: tracking.trackingRefs,
        intake: {
          occurredAt,
          occurrenceKey,
          recovery: mapped.recovery,
        },
        ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
      };

      return { kind: "verified", observation };
    },
  };
}
