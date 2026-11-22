import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  CanonicalLocalFulfillmentStatus,
  FulfillmentObservation,
  FulfillmentObservationCodecs,
  FulfillmentObservationPort,
  FulfillmentTrackingReference,
} from "@openlup/platform/fulfillment/contracts";

export const SHIPBOB_PROVIDER_REF = "shipbob" as const;
export const SHIPBOB_MAPPER_VERSION = "shipbob-rest-v1-v2025" as const;

const MIN_WHSEC_DECODED_BYTES = 16;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const UNIX_EPOCH_SECONDS_REGEX = /^\d{9,12}$/u;
const STRICT_BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/u;
const SAFE_REF_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RFC3339_OFFSET_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

export interface ShipBobWebhookVerifierOptions {
  /** One or more Standard Webhooks signing secrets (`whsec_<base64>`, decoded >= 16 bytes) for key rotation. */
  readonly webhookSigningSecrets: readonly string[];
  /** Optional maximum timestamp skew in milliseconds for replay protection against `webhook-timestamp`. */
  readonly maxTimestampSkewMs?: number;
  /** Optional carrier tracking URL approval predicate matching host policy. */
  readonly approveTrackingUrl?: (url: string) => boolean;
  /** Optional explicit observation codecs matching host policy. */
  readonly observationCodecs?: FulfillmentObservationCodecs;
  /** Optional maximum raw webhook body size in bytes (defaults to 2 MiB). */
  readonly maxBodyBytes?: number;
}

export interface MappedShipBobStatus {
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

function normalizeStatusToken(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/gu, "");
}

function normalizeTopicToken(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[.-]+/gu, "_");
}

function mapExceptionOrCancelToken(token: string): MappedShipBobStatus | null {
  switch (token) {
    case "EXCEPTION":
    case "ONHOLD":
    case "RETURNED":
      return { canonicalStatus: "exception", eventKind: "parcel.exception", recovery: "manual" };
    case "DELIVERYEXCEPTION":
    case "UNDELIVERABLE":
    case "LOST":
      return { canonicalStatus: "exception", eventKind: "parcel.exception", recovery: "delivery_only" };
    case "CANCELLED":
    case "CANCELED":
      return { canonicalStatus: "cancelled", eventKind: "parcel.cancelled", recovery: null };
    default:
      return null;
  }
}

function mapProgressToken(token: string): MappedShipBobStatus | null {
  switch (token) {
    case "DELIVERED":
      return { canonicalStatus: "delivered", eventKind: "order.delivered", recovery: null };
    case "COMPLETED":
    case "SHIPPED":
    case "INTRANSIT":
    case "LABELEDCREATED":
    case "LABELCREATED":
      return { canonicalStatus: "in_transit", eventKind: "order.shipped", recovery: null };
    case "PACKED":
      return { canonicalStatus: "packed", eventKind: "order.picked", recovery: null };
    case "PICKED":
      return { canonicalStatus: "picking", eventKind: "order.processing_started", recovery: null };
    case "PROCESSING":
    case "IMPORTREVIEW":
      return { canonicalStatus: "provider_received", eventKind: "order.processing_started", recovery: null };
    default:
      return null;
  }
}

export function mapShipBobStatus(
  orderStatusRaw: string | null | undefined,
  shipmentStatusRaw?: string | null,
  topicRaw?: string | null,
): MappedShipBobStatus | null {
  const order = normalizeStatusToken(orderStatusRaw);
  const shipment = normalizeStatusToken(shipmentStatusRaw);
  const topic = normalizeTopicToken(topicRaw);

  // 1. Order-level exceptions & cancellations always outrank transit/delivery.
  const orderEx = mapExceptionOrCancelToken(order);
  if (orderEx) return orderEx;

  // 2. Shipment-level exceptions & cancellations outrank normal progress.
  const shipmentEx = mapExceptionOrCancelToken(shipment);
  if (shipmentEx) return shipmentEx;

  // 3. Topic-level exceptions & cancellations outrank normal progress.
  if (
    topic === "order_shipment_onhold" ||
    topic === "order_shipment_on_hold" ||
    topic === "order_shipment_exception"
  ) {
    return { canonicalStatus: "exception", eventKind: "parcel.exception", recovery: "manual" };
  }
  if (
    topic === "order_shipment_cancelled" ||
    topic === "order_shipment_canceled" ||
    topic === "order_cancelled" ||
    topic === "order_canceled"
  ) {
    return { canonicalStatus: "cancelled", eventKind: "parcel.cancelled", recovery: null };
  }

  // 4. Normal shipment progress (delivered / in-transit).
  if (
    shipment === "DELIVERED" ||
    topic === "order_shipment_delivered" ||
    topic === "order_delivered"
  ) {
    return { canonicalStatus: "delivered", eventKind: "order.delivered", recovery: null };
  }
  if (
    shipment === "COMPLETED" ||
    shipment === "SHIPPED" ||
    shipment === "INTRANSIT" ||
    shipment === "LABELEDCREATED" ||
    shipment === "LABELCREATED"
  ) {
    return { canonicalStatus: "in_transit", eventKind: "order.shipped", recovery: null };
  }

  // 5. Topic-level normal progress.
  if (topic === "order_shipped") {
    return { canonicalStatus: "in_transit", eventKind: "order.shipped", recovery: null };
  }

  // 6. Order-level lifecycle fallback.
  const orderProgress = mapProgressToken(order);
  if (orderProgress) return orderProgress;

  // 7. Shipment-level early lifecycle fallback.
  return mapProgressToken(shipment);
}

const SHIPMENT_STATUS_PRECEDENCE: readonly string[] = [
  "EXCEPTION",
  "ONHOLD",
  "RETURNED",
  "DELIVERYEXCEPTION",
  "UNDELIVERABLE",
  "LOST",
  "CANCELLED",
  "CANCELED",
  "DELIVERED",
  "COMPLETED",
  "SHIPPED",
  "INTRANSIT",
  "LABELEDCREATED",
  "LABELCREATED",
  "PACKED",
  "PICKED",
  "PROCESSING",
  "IMPORTREVIEW",
];

/**
 * Inspect all ShipBob shipments for an order and pick the highest-precedence status
 * so an exception or cancellation on one shipment is never masked by another.
 */
export function resolveShipBobAggregateShipmentStatus(
  shipments: readonly { readonly status?: string | null }[] | undefined,
): string | null {
  if (!shipments || shipments.length === 0) return null;
  let bestStatus: string | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const shipment of shipments) {
    const raw = typeof shipment.status === "string" ? shipment.status.trim() : "";
    if (!raw) continue;
    const token = normalizeStatusToken(raw);
    const rank = SHIPMENT_STATUS_PRECEDENCE.indexOf(token);
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

function decodeStrictBase64(b64: string): Buffer | null {
  if (!b64 || b64.length % 4 !== 0 || !STRICT_BASE64_REGEX.test(b64)) {
    return null;
  }
  const decoded = Buffer.from(b64, "base64");
  if (decoded.byteLength === 0 || decoded.toString("base64") !== b64) {
    return null;
  }
  return decoded;
}

function parseStandardWebhookSecret(secretWhsec: string): Buffer | null {
  if (typeof secretWhsec !== "string") return null;
  const trimmed = secretWhsec.trim();
  if (!trimmed.startsWith("whsec_")) return null;
  const b64 = trimmed.slice("whsec_".length);
  const decoded = decodeStrictBase64(b64);
  if (!decoded || decoded.byteLength < MIN_WHSEC_DECODED_BYTES) {
    return null;
  }
  return decoded;
}

/**
 * Compute a Standard Webhooks (Svix) v1 HMAC-SHA256 signature over
 * `${webhookId}.${timestampSec}.${rawBody}` using a `whsec_<base64>` secret.
 */
export function computeStandardWebhookSignature(
  webhookId: string,
  timestampSec: string,
  rawBody: Uint8Array | string,
  secretWhsec: string,
): string {
  const key = parseStandardWebhookSecret(secretWhsec);
  if (!key) {
    throw new Error("shipbob_webhook_signing_secret_invalid");
  }
  const prefix = Buffer.from(`${webhookId}.${timestampSec}.`, "utf8");
  const bodyBytes = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const macB64 = createHmac("sha256", key).update(prefix).update(bodyBytes).digest("base64");
  return `v1,${macB64}`;
}

function isValidRfc3339(value: unknown): value is string {
  return typeof value === "string" && RFC3339_OFFSET_REGEX.test(value) && Number.isFinite(Date.parse(value));
}

function safeRef(value: unknown, approveReference?: (v: string) => boolean): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
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

function isSupportedOrderTopic(topic: string): boolean {
  if (!topic) return true;
  const normalized = normalizeTopicToken(topic);
  return normalized.startsWith("order") || normalized.startsWith("shipment");
}

function extractTrackingEntries(
  payload: Record<string, unknown>,
): readonly {
  readonly trackingNumber?: unknown;
  readonly carrierCode?: unknown;
  readonly serviceRef?: unknown;
  readonly trackingUrl?: unknown;
}[] {
  const results: {
    trackingNumber?: unknown;
    carrierCode?: unknown;
    serviceRef?: unknown;
    trackingUrl?: unknown;
  }[] = [];

  const pushTrackingObj = (obj: Record<string, unknown>) => {
    const trackingObj =
      obj["tracking"] && typeof obj["tracking"] === "object"
        ? (obj["tracking"] as Record<string, unknown>)
        : obj;
    if (trackingObj["tracking_number"] !== undefined) {
      results.push({
        trackingNumber: trackingObj["tracking_number"],
        carrierCode: trackingObj["carrier"],
        serviceRef: trackingObj["shipping_method"],
        trackingUrl: trackingObj["tracking_url"],
      });
    }
  };

  if (Array.isArray(payload["shipments"])) {
    for (const entry of payload["shipments"]) {
      if (entry && typeof entry === "object") {
        pushTrackingObj(entry as Record<string, unknown>);
      }
    }
  }

  if (results.length === 0) {
    pushTrackingObj(payload);
  }

  return results;
}

/**
 * Create an auth-before-parse `FulfillmentObservationPort` for ShipBob
 * Standard Webhooks (Svix) notifications.
 */
export function createShipBobWebhookVerifier(
  options: ShipBobWebhookVerifierOptions,
): FulfillmentObservationPort {
  const parsedKeys = options.webhookSigningSecrets
    .map((secret) => parseStandardWebhookSecret(secret))
    .filter((key): key is Buffer => key !== null);

  if (parsedKeys.length === 0 || parsedKeys.length !== options.webhookSigningSecrets.length) {
    throw new Error("shipbob_webhook_signing_secret_invalid");
  }
  if (
    options.maxTimestampSkewMs !== undefined &&
    (!Number.isFinite(options.maxTimestampSkewMs) || options.maxTimestampSkewMs < 0)
  ) {
    throw new Error("shipbob_webhook_max_skew_invalid");
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isFinite(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("shipbob_webhook_max_body_bytes_invalid");
  }

  return {
    async verifyAndNormalize(input) {
      // 1. Auth-before-parse: verify Standard Webhooks headers + HMAC over raw untouched bytes.
      const webhookId = getHeaderInsensitive(input.headers, "webhook-id")?.trim() ?? "";
      const timestampSec = getHeaderInsensitive(input.headers, "webhook-timestamp")?.trim() ?? "";
      const signatureHeader = getHeaderInsensitive(input.headers, "webhook-signature")?.trim() ?? "";

      if (
        !webhookId ||
        /[\s\p{Cc}\p{Cf}]/u.test(webhookId) ||
        !UNIX_EPOCH_SECONDS_REGEX.test(timestampSec) ||
        !signatureHeader
      ) {
        return {
          kind: "refused",
          refusal: { reason: "untrusted", phase: "verify", retryable: false },
        };
      }

      if (input.rawBody.byteLength > maxBodyBytes) {
        return {
          kind: "refused",
          refusal: { reason: "malformed", phase: "verify", retryable: false },
        };
      }

      if (options.maxTimestampSkewMs !== undefined && isValidRfc3339(input.receivedAt)) {
        const headerMs = Number(timestampSec) * 1000;
        const skewMs = Math.abs(Date.parse(input.receivedAt) - headerMs);
        if (skewMs > options.maxTimestampSkewMs) {
          return {
            kind: "refused",
            refusal: { reason: "untrusted", phase: "verify", retryable: false },
          };
        }
      }

      const candidateBuffers: Buffer[] = [];
      for (const token of signatureHeader.split(/\s+/u)) {
        if (!token.startsWith("v1,")) continue;
        const sigB64 = token.slice(3);
        const decoded = decodeStrictBase64(sigB64);
        if (decoded && decoded.byteLength === 32) {
          candidateBuffers.push(decoded);
        }
      }

      if (candidateBuffers.length === 0) {
        return {
          kind: "refused",
          refusal: { reason: "untrusted", phase: "verify", retryable: false },
        };
      }

      const signedPrefix = Buffer.from(`${webhookId}.${timestampSec}.`, "utf8");
      const authentic = parsedKeys.some((key) => {
        const expected = createHmac("sha256", key)
          .update(signedPrefix)
          .update(input.rawBody)
          .digest();
        return candidateBuffers.some((candidate) => timingSafeEqual(expected, candidate));
      });

      if (!authentic) {
        return {
          kind: "refused",
          refusal: { reason: "untrusted", phase: "verify", retryable: false },
        };
      }

      // 2. Parse & normalize only after authentication succeeded.
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

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          kind: "refused",
          refusal: { reason: "malformed", phase: "normalize", retryable: false },
        };
      }

      const envelope = parsed as Record<string, unknown>;
      const topicRaw =
        typeof envelope["topic"] === "string"
          ? envelope["topic"]
          : typeof envelope["event_type"] === "string"
            ? envelope["event_type"]
            : typeof envelope["type"] === "string"
              ? envelope["type"]
              : "";

      if (topicRaw && !isSupportedOrderTopic(topicRaw)) {
        return {
          kind: "refused",
          refusal: { reason: "unsupported_event", phase: "normalize", retryable: false },
        };
      }

      const data = (
        envelope["data"] && typeof envelope["data"] === "object" && !Array.isArray(envelope["data"])
          ? envelope["data"]
          : envelope
      ) as Record<string, unknown>;

      const numericOrderId = safeRef(
        data["order_id"] ?? data["id"],
        options.observationCodecs?.approveReference,
      );
      const referenceId = safeRef(
        data["reference_id"],
        options.observationCodecs?.approveReference,
      );
      const externalRef = numericOrderId ?? referenceId;

      if (!externalRef) {
        return {
          kind: "refused",
          refusal: { reason: "missing_correlation", phase: "normalize", retryable: false },
          diagnostics: { rejectedCorrelationRefs: 1 },
        };
      }

      const orderStatus =
        typeof data["status"] === "string"
          ? data["status"].trim()
          : typeof data["order_status"] === "string"
            ? data["order_status"].trim()
            : "";

      const rawShipments = Array.isArray(data["shipments"])
        ? data["shipments"].filter(
            (entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"),
          )
        : [];
      const topLevelShipmentStatus =
        typeof data["shipment_status"] === "string" && data["shipment_status"].trim()
          ? data["shipment_status"].trim()
          : null;
      const shipmentCandidates: { readonly status?: string | null }[] = [
        ...(topLevelShipmentStatus ? [{ status: topLevelShipmentStatus }] : []),
        ...rawShipments.map((s) => ({
          status: typeof s["status"] === "string" ? s["status"] : null,
        })),
      ];
      const shipmentStatus = resolveShipBobAggregateShipmentStatus(shipmentCandidates);

      const mapped = mapShipBobStatus(orderStatus, shipmentStatus, topicRaw);
      if (!mapped) {
        return {
          kind: "refused",
          refusal: { reason: "unsupported_event", phase: "normalize", retryable: false },
        };
      }

      const occurredAtRaw =
        data["last_updated_at"] ??
        data["updated_date"] ??
        data["created_date"] ??
        envelope["timestamp"] ??
        envelope["occurred_at"];
      let occurredAt: string;
      if (occurredAtRaw !== undefined && occurredAtRaw !== null) {
        if (!isValidRfc3339(occurredAtRaw)) {
          return {
            kind: "refused",
            refusal: { reason: "malformed", phase: "normalize", retryable: false },
            diagnostics: { invalidTimestamp: true },
          };
        }
        occurredAt = new Date(Date.parse(occurredAtRaw)).toISOString();
      } else {
        occurredAt = new Date(Number(timestampSec) * 1000).toISOString();
      }
      const receivedAt = new Date(Date.parse(input.receivedAt)).toISOString();

      const digest = createHash("sha256").update(input.rawBody).digest("hex");
      const rawRef = deterministicEvidenceReference(digest);

      const safeWebhookId = safeRef(webhookId);
      const occurrenceKey =
        safeWebhookId ??
        `sb_${createHash("sha256").update(webhookId, "utf8").digest("hex").slice(0, 24)}`;

      const eventKey = `shipbob:${externalRef}:${mapped.eventKind}:${mapped.canonicalStatus}:${occurredAt}:${occurrenceKey}`;
      const factId = `sb_fact_${createHash("sha256").update(eventKey).digest("hex").slice(0, 24)}`;

      const tracking = buildNormalizedTrackingRefs({
        rawTracking: extractTrackingEntries(data),
        approveTrackingUrl: options.approveTrackingUrl,
        codecs: options.observationCodecs,
      });

      const orderNumber = safeRef(data["order_number"], options.observationCodecs?.approveReference);
      const fulfillmentRef = safeRef(
        data["fulfillmentRef"],
        options.observationCodecs?.approveReference,
      );
      const orderRef = safeRef(data["orderRef"], options.observationCodecs?.approveReference);
      const parcelRef =
        safeRef(data["parcelRef"], options.observationCodecs?.approveReference) ??
        referenceId;

      const latestShipment =
        rawShipments.length > 0 ? rawShipments[rawShipments.length - 1] : undefined;
      const shipmentId = latestShipment
        ? safeRef(latestShipment["id"], options.observationCodecs?.approveReference)
        : safeRef(data["shipment_id"], options.observationCodecs?.approveReference);
      const providerFulfillmentRef = shipmentId ?? numericOrderId ?? externalRef;

      const primaryStatus = safeRef(orderStatus) ?? safeRef(topicRaw) ?? null;
      const subStatus = safeRef(shipmentStatus) ?? (orderStatus ? safeRef(topicRaw) : null);

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
          externalRef,
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
          mapperVersion: SHIPBOB_MAPPER_VERSION,
          factId,
          providerKind: SHIPBOB_PROVIDER_REF,
          fulfillmentReference: externalRef,
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
