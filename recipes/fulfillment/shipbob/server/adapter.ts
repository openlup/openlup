import { createHash } from "node:crypto";
import type {
  DispatchEvidence,
  FulfillmentCapabilityDescriptor,
  FulfillmentDispatchPort,
  FulfillmentDispatchRequest,
  FulfillmentDispatchResult,
  FulfillmentLabelPort,
  FulfillmentObservation,
  FulfillmentObservationCodecs,
  FulfillmentObservationPagePort,
  FulfillmentOperationError,
  FulfillmentProductSyncProvider,
  FulfillmentProviderAdapter,
  FulfillmentReadbackPort,
  FulfillmentReadbackResult,
  FulfillmentReconciliationObservation,
  FulfillmentRefusal,
  FulfillmentStockSyncProvider,
  StockSnapshot,
} from "@openlup/platform/fulfillment/contracts";
import {
  ShipBobTransportError,
  assertSafeShipBobOrderId,
  sanitizeDiagnosticCode,
  type ShipBobClient,
  type ShipBobCreateOrderPayload,
  type ShipBobOrderRecord,
} from "./client-contract.js";
import {
  SHIPBOB_MAPPER_VERSION,
  SHIPBOB_PROVIDER_REF,
  buildNormalizedTrackingRefs,
  createShipBobWebhookVerifier,
  deterministicEvidenceReference,
  mapShipBobStatus,
  resolveShipBobAggregateShipmentStatus,
} from "./webhook.js";

const SAFE_REF_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NUMERIC_ID_REGEX = /^[0-9]{1,20}$/u;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/u;
const RFC3339_OFFSET_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const MAX_PREPARED_ENTRIES = 2048;
const MAX_OUTCOME_ENTRIES = 2048;
const MAX_INVENTORY_PAGES = 100;
const DEFAULT_INVENTORY_PAGE_SIZE = 250;

/**
 * Static default-off capability descriptor for ShipBob 3PL (REST API v1.0 / v2025).
 * Never mutated; `createShipBobFulfillmentAdapter` clones this descriptor per instance.
 */
export const shipbobFulfillmentCapabilities: Readonly<FulfillmentCapabilityDescriptor> = Object.freeze({
  providerRef: SHIPBOB_PROVIDER_REF,
  role: "warehouse",
  operations: Object.freeze({
    dispatch: Object.freeze({ supported: true as const }),
    readback: Object.freeze({ supported: true as const }),
    exactAbsence: Object.freeze({ supported: false as const, reason: "not_exposed" as const }),
    verifyObservation: Object.freeze({ supported: true as const }),
    syncStock: Object.freeze({ supported: true as const }),
    syncProducts: Object.freeze({ supported: false as const, reason: "not_exposed" as const }),
    labelCreate: Object.freeze({ supported: false as const, reason: "not_exposed" as const }),
    labelRead: Object.freeze({ supported: false as const, reason: "not_exposed" as const }),
    labelVoid: Object.freeze({ supported: false as const, reason: "not_exposed" as const }),
    cancel: Object.freeze({ supported: false as const, reason: "not_exposed" as const }),
    pickupPoint: Object.freeze({ supported: false as const, reason: "not_exposed" as const }),
    courierPickup: Object.freeze({ supported: false as const, reason: "not_exposed" as const }),
  }),
  authentication: "authenticated_timestamp",
  freshness: "authenticated_timestamp",
  defaultOff: true,
  selected: false,
  readiness: Object.freeze({
    ready: false as const,
    refusal: Object.freeze({
      reason: "not_ready" as const,
      phase: "selection" as const,
      retryable: false,
    }),
  }),
  ownsDeliveredNotification: false,
  stockAuthority: "external_stock_master_with_local_reservations",
  inventory: Object.freeze({
    reservationOwner: "local" as const,
    consumption: "finished_picking" as const,
  }),
  stockMovements: false,
  independentSplits: false,
  transportSelection: "provider",
  labelReadOwner: "none",
  actionPolicy: Object.freeze({
    providerSpecificAdminActions: false,
    genericAdminActions: true,
    mutationSurface: "provider_adapter" as const,
  }),
});

/** Pure JSON-safe projection of static capabilities matching `recipe.json#staticCapabilities`. */
export function projectShipBobStaticCapabilities(): FulfillmentCapabilityDescriptor {
  return JSON.parse(JSON.stringify(shipbobFulfillmentCapabilities)) as FulfillmentCapabilityDescriptor;
}

export interface CreateShipBobFulfillmentAdapterOptions {
  readonly client: ShipBobClient;
  readonly webhookSigningSecrets: readonly string[];
  readonly clock: () => string;
  readonly selected?: boolean;
  readonly ready?: boolean;
  readonly approveTrackingUrl?: (url: string) => boolean;
  readonly observationCodecs?: FulfillmentObservationCodecs;
  readonly maxTimestampSkewMs?: number;
  readonly maxWebhookBodyBytes?: number;
  readonly defaultShippingMethod?: string;
  readonly inventoryPageSize?: number;
}

interface PreparedCommandEntry {
  readonly requestKey: string;
  readonly fulfillmentRef: string;
  readonly referenceId: string;
  readonly command: ShipBobCreateOrderPayload;
  readonly evidence: DispatchEvidence;
}

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
  map.set(key, value);
}

function safeRef(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && SAFE_REF_REGEX.test(trimmed) ? trimmed : null;
}

function safeIsoDate(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  if (!ISO_DATE_REGEX.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10) === value ? value : null;
}

function safeRfc3339(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !RFC3339_OFFSET_REGEX.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function buildReferenceId(request: FulfillmentDispatchRequest): string | null {
  const candidate = (request.parcelRef ?? request.fulfillmentRef).trim();
  if (!candidate || candidate.length > 128 || !SAFE_REF_REGEX.test(candidate)) {
    return null;
  }
  try {
    return assertSafeShipBobOrderId(candidate);
  } catch {
    return null;
  }
}

function toOperationError(
  error: unknown,
  defaultMayHaveSucceeded: boolean,
): FulfillmentOperationError {
  if (error instanceof ShipBobTransportError) {
    return {
      code: sanitizeDiagnosticCode(error.code, "shipbob_operation_failed"),
      status: error.status,
      retryable: error.retryable,
      mayHaveSucceeded: error.mayHaveSucceeded,
      submissionAttempted: error.submissionAttempted,
      responseBodyRead: error.responseBodyRead,
    };
  }
  return {
    code: "shipbob_transport_error",
    status: null,
    retryable: true,
    mayHaveSucceeded: defaultMayHaveSucceeded,
    submissionAttempted: defaultMayHaveSucceeded,
    responseBodyRead: false,
  };
}

function buildObservationFromOrderRecord(params: {
  readonly record: ShipBobOrderRecord;
  readonly source: "provider_response" | "provider_reconciliation";
  readonly receivedAt: string;
  readonly externalRefOverride?: string;
  readonly correlationOverride?: {
    readonly fulfillmentRef?: string | null;
  };
  readonly approveTrackingUrl?: (url: string) => boolean;
  readonly observationCodecs?: FulfillmentObservationCodecs;
}): FulfillmentReconciliationObservation {
  const recordOrderId = params.record.id !== null ? String(params.record.id) : null;
  const recordReferenceId = safeRef(params.record.reference_id);
  const externalRef = params.externalRefOverride ?? recordOrderId ?? recordReferenceId;

  const shipments = params.record.shipments ?? [];
  const latestShipment = shipments.length > 0 ? shipments[shipments.length - 1] : undefined;
  const shipmentStatus = resolveShipBobAggregateShipmentStatus(shipments);
  const mapped = mapShipBobStatus(params.record.status, shipmentStatus);

  const occurredAt =
    safeRfc3339(params.record.last_updated_at) ??
    safeRfc3339(latestShipment?.last_updated_at) ??
    safeRfc3339(latestShipment?.actual_fulfillment_date) ??
    safeRfc3339(params.record.created_date) ??
    params.receivedAt;
  const createdAt = safeRfc3339(params.record.created_date);
  const updatedAt = safeRfc3339(params.record.last_updated_at) ?? occurredAt;

  const canonicalSnapshot = JSON.stringify({
    id: params.record.id,
    reference_id: params.record.reference_id ?? null,
    status: params.record.status,
    shipmentStatus,
    updatedAt,
  });
  const digest = createHash("sha256").update(canonicalSnapshot, "utf8").digest("hex");
  const rawRef = deterministicEvidenceReference(digest);

  const primaryStatus = safeRef(params.record.status);
  const subStatus = safeRef(shipmentStatus);
  const orderNumber = safeRef(params.record.order_number);
  const providerFulfillmentRef = safeRef(latestShipment?.id) ?? recordOrderId ?? externalRef;
  const fulfillmentRef = safeRef(params.correlationOverride?.fulfillmentRef) ?? null;

  const correlation: FulfillmentObservation["correlation"] = {
    orderRef: null,
    fulfillmentRef,
    externalRef,
    orderNumber,
    providerFulfillmentRef,
    parcelRef: recordReferenceId,
  };

  if (!externalRef || !mapped) {
    const unmappedEventKey = `shipbob:unmapped:${externalRef ?? "unknown"}:${digest.slice(0, 16)}`;
    return {
      kind: "unmapped",
      externalRef,
      evidence: {
        eventKey: unmappedEventKey,
        correlation,
        providerStatus: {
          primary: primaryStatus,
          subStatus,
        },
      },
    };
  }

  const occurrenceKey = `sb_rb_${digest.slice(0, 24)}`;
  const eventKey = `shipbob:${externalRef}:${mapped.eventKind}:${mapped.canonicalStatus}:${occurredAt}:${occurrenceKey}`;
  const factId = `sb_fact_${createHash("sha256").update(eventKey).digest("hex").slice(0, 24)}`;

  const rawTracking = shipments
    .filter((shipment) => shipment.tracking?.tracking_number !== undefined)
    .map((shipment) => ({
      trackingNumber: shipment.tracking?.tracking_number,
      carrierCode: shipment.tracking?.carrier,
      serviceRef: shipment.tracking?.shipping_method,
      trackingUrl: shipment.tracking?.tracking_url,
    }));

  const tracking = buildNormalizedTrackingRefs({
    rawTracking,
    approveTrackingUrl: params.approveTrackingUrl,
    codecs: params.observationCodecs,
  });

  const diagnostics: NonNullable<FulfillmentObservation["diagnostics"]> = {};
  if (tracking.rejectedTrackingRefs > 0 || tracking.rejectedTrackingUrls > 0) {
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
    correlation,
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
        source: params.source,
        authority: "provider_asserted",
      },
      occurredAt,
      receivedAt: params.receivedAt,
      rawEvent: {
        reference: rawRef,
        digestAlgorithm: "sha256",
        digest,
      },
    },
    eventKind: mapped.eventKind,
    firstReceivedAt: params.receivedAt,
    trackingRefs: tracking.trackingRefs,
    intake: {
      occurredAt,
      occurrenceKey,
      recovery: mapped.recovery,
    },
    ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
  };

  return {
    kind: "found",
    externalRef,
    createdAt,
    updatedAt,
    observation,
  };
}

function cloneResult<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Create a complete, zero-SDK ShipBob 3PL (`shipbob`) `FulfillmentProviderAdapter`
 * implementing dispatch, Standard Webhooks (Svix) verification, exact readback
 * (by numeric order ID or `reference_id`), 1-based page reconciliation,
 * snapshot-only inventory sync, and explicit zero-I/O refusals for unsupported ports.
 */
export function createShipBobFulfillmentAdapter(
  options: CreateShipBobFulfillmentAdapterOptions,
): FulfillmentProviderAdapter {
  const defaultShippingMethod = (options.defaultShippingMethod ?? "Standard").trim() || "Standard";
  const inventoryPageSize =
    options.inventoryPageSize !== undefined &&
    Number.isSafeInteger(options.inventoryPageSize) &&
    options.inventoryPageSize > 0
      ? options.inventoryPageSize
      : DEFAULT_INVENTORY_PAGE_SIZE;

  const baseCaps = projectShipBobStaticCapabilities();
  const capabilities: FulfillmentCapabilityDescriptor = {
    ...baseCaps,
    selected: options.selected === true,
    readiness:
      options.ready === true
        ? { ready: true }
        : {
            ready: false,
            refusal: { reason: "not_ready", phase: "selection", retryable: false },
          },
  };

  const preparedByFingerprint = new Map<string, PreparedCommandEntry>();
  const retainedOutcomes = new Map<string, FulfillmentDispatchResult>();
  let exhaustedAtPage: number | null = null;

  const dispatch: FulfillmentDispatchPort = {
    async prepare(request) {
      if (!request.selection.providerRef) {
        return {
          kind: "refused",
          refusal: { reason: "selection_required", phase: "selection", retryable: false },
        };
      }
      if (request.selection.providerRef !== SHIPBOB_PROVIDER_REF) {
        return {
          kind: "refused",
          refusal: { reason: "provider_mismatch", phase: "selection", retryable: false },
        };
      }
      if (request.selection.deliveryKind === "parcel-locker" || request.selection.pickupPoint !== null) {
        return {
          kind: "refused",
          refusal: { reason: "unsupported", phase: "prepare", retryable: false },
        };
      }

      const referenceId = buildReferenceId(request);
      const validLines =
        request.lines.length > 0 &&
        request.lines.every(
          (line) =>
            Boolean(line.skuRef.trim()) &&
            Number.isSafeInteger(line.quantity) &&
            line.quantity > 0,
        );
      const line1 = request.recipient.line1.trim();
      const city = request.recipient.city.trim();
      const postalCode = request.recipient.postalCode.trim();
      const country = request.recipient.country.trim().toUpperCase();
      const validAddress =
        Boolean(line1) &&
        Boolean(city) &&
        Boolean(postalCode) &&
        /^[A-Z]{2}$/u.test(country);

      if (!referenceId || !request.requestKey.trim() || !validLines || !validAddress) {
        return {
          kind: "refused",
          refusal: { reason: "not_dispatchable", phase: "prepare", retryable: false },
        };
      }

      const orderNumber = (request.orderNumber?.trim() || request.orderRef.trim()).slice(0, 128);
      const shippingMethod = request.selection.serviceRef?.trim() || defaultShippingMethod;
      const line2 = request.recipient.line2?.trim() || undefined;
      const email = request.recipient.email?.trim() || undefined;
      const phone = request.recipient.phone?.trim() || undefined;

      const command: ShipBobCreateOrderPayload = {
        reference_id: referenceId,
        order_number: orderNumber,
        shipping_method: shippingMethod,
        recipient: {
          name: request.recipient.name?.trim() || "Recipient",
          address: {
            address1: line1,
            ...(line2 ? { address2: line2 } : {}),
            city,
            zip_code: postalCode,
            country,
          },
          ...(email ? { email } : {}),
          ...(phone ? { phone_number: phone } : {}),
        },
        products: request.lines.map((line) => ({
          reference_id: line.skuRef.trim(),
          quantity: line.quantity,
        })),
      };

      const commandFingerprint = createHash("sha256")
        .update(JSON.stringify(command), "utf8")
        .digest("hex");

      let redactedFieldCount = 0;
      const carrierRef =
        request.selection.carrierRef === null
          ? null
          : (safeRef(request.selection.carrierRef) ?? ((redactedFieldCount += 1), null));
      const serviceRef =
        request.selection.serviceRef === null
          ? null
          : (safeRef(request.selection.serviceRef) ?? ((redactedFieldCount += 1), null));

      const items = request.lines.map((line) => {
        const skuRef = safeRef(line.skuRef) ?? ((redactedFieldCount += 1), "redacted");
        const lotRef =
          line.lotRef == null
            ? null
            : (safeRef(line.lotRef) ?? ((redactedFieldCount += 1), null));
        const expirationDate =
          line.expirationDate == null
            ? null
            : (safeIsoDate(line.expirationDate) ?? ((redactedFieldCount += 1), null));
        return {
          skuRef,
          quantity: line.quantity,
          lotRef,
          expirationDate,
        };
      });

      const evidence: DispatchEvidence = {
        commandFingerprint,
        contactRevision: {
          schemaVersion: request.contactRevision.schemaVersion,
          source: request.contactRevision.source,
          revision: request.contactRevision.revision,
        },
        providerRef: SHIPBOB_PROVIDER_REF,
        carrierRef,
        serviceRef,
        transcript: {
          itemCount: items.length,
          items,
          deliveryKind: "courier",
          pickupPointRef: null,
          ...(redactedFieldCount > 0 ? { redactedFieldCount } : {}),
        },
      };

      boundedSet(
        preparedByFingerprint,
        commandFingerprint,
        {
          requestKey: request.requestKey,
          fulfillmentRef: request.fulfillmentRef,
          referenceId,
          command,
          evidence,
        },
        MAX_PREPARED_ENTRIES,
      );

      return { kind: "prepared", evidence: cloneResult(evidence) };
    },

    async dispatch(request, evidence) {
      const prepared = preparedByFingerprint.get(evidence.commandFingerprint);
      const matchesPrepared =
        prepared !== undefined &&
        prepared.requestKey === request.requestKey &&
        prepared.fulfillmentRef === request.fulfillmentRef &&
        prepared.evidence.providerRef === evidence.providerRef &&
        prepared.evidence.contactRevision.schemaVersion === evidence.contactRevision.schemaVersion &&
        prepared.evidence.contactRevision.source === evidence.contactRevision.source &&
        prepared.evidence.contactRevision.revision === evidence.contactRevision.revision;

      if (!matchesPrepared) {
        return {
          kind: "not_dispatched",
          effectMayHaveSucceeded: false,
          refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false },
        };
      }

      const retained = retainedOutcomes.get(evidence.commandFingerprint);
      if (retained) {
        return cloneResult(retained);
      }

      try {
        const created = await options.client.createOrder(prepared.command);
        if (
          !created ||
          (created.reference_id !== undefined && created.reference_id !== prepared.referenceId)
        ) {
          const malformedResult: FulfillmentDispatchResult = {
            kind: "unknown",
            effectMayHaveSucceeded: true,
            refusal: { reason: "io_failure", phase: "dispatch", retryable: true },
            error: {
              code: "shipbob_malformed_response",
              status: null,
              retryable: true,
              mayHaveSucceeded: true,
              submissionAttempted: true,
              responseBodyRead: true,
            },
          };
          boundedSet(retainedOutcomes, evidence.commandFingerprint, malformedResult, MAX_OUTCOME_ENTRIES);
          return cloneResult(malformedResult);
        }
        const externalRef =
          created.id !== null && created.id !== undefined
            ? String(created.id)
            : prepared.referenceId;
        const receiptKey = `shipbob:receipt:${externalRef}`;
        const accepted: FulfillmentDispatchResult = {
          kind: "accepted",
          externalRef,
          evidence: cloneResult(prepared.evidence),
          providerAttemptKey: `shipbob:attempt:${evidence.commandFingerprint.slice(0, 24)}`,
          labelKey: receiptKey,
          receiptKey,
        };
        boundedSet(retainedOutcomes, evidence.commandFingerprint, accepted, MAX_OUTCOME_ENTRIES);
        return cloneResult(accepted);
      } catch (error) {
        const opError = toOperationError(error, true);
        if (opError.submissionAttempted === false) {
          return {
            kind: "not_dispatched",
            effectMayHaveSucceeded: false,
            refusal: { reason: "io_failure", phase: "dispatch", retryable: opError.retryable },
            error: opError,
          };
        }
        if (!opError.mayHaveSucceeded) {
          return {
            kind: "not_dispatched",
            effectMayHaveSucceeded: false,
            refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false },
            error: opError,
          };
        }
        const unknownResult: FulfillmentDispatchResult = {
          kind: "unknown",
          effectMayHaveSucceeded: true,
          refusal: { reason: "io_failure", phase: "dispatch", retryable: true },
          error: opError,
        };
        boundedSet(retainedOutcomes, evidence.commandFingerprint, unknownResult, MAX_OUTCOME_ENTRIES);
        return cloneResult(unknownResult);
      }
    },
  };

  const observation = createShipBobWebhookVerifier({
    webhookSigningSecrets: options.webhookSigningSecrets,
    approveTrackingUrl: options.approveTrackingUrl,
    observationCodecs: options.observationCodecs,
    maxTimestampSkewMs: options.maxTimestampSkewMs,
    maxBodyBytes: options.maxWebhookBodyBytes,
  });

  const readback: FulfillmentReadbackPort = {
    async read(input): Promise<FulfillmentReadbackResult> {
      if (input.providerRef !== SHIPBOB_PROVIDER_REF) {
        return {
          kind: "unknown",
          refusal: { reason: "provider_mismatch", phase: "readback", retryable: false },
        };
      }
      if (input.externalRef === null || !input.externalRef.trim()) {
        return {
          kind: "unsupported",
          refusal: { reason: "unsupported", phase: "readback", retryable: false },
        };
      }
      let safeOrderId: string;
      try {
        safeOrderId = assertSafeShipBobOrderId(input.externalRef);
      } catch {
        return {
          kind: "unknown",
          refusal: { reason: "malformed", phase: "readback", retryable: false },
        };
      }

      const isNumericId = NUMERIC_ID_REGEX.test(safeOrderId);
      try {
        const record = isNumericId
          ? await options.client.getOrder(safeOrderId)
          : await options.client.getOrderByReferenceId(safeOrderId);
        if (!record) {
          return {
            kind: "unknown",
            refusal: { reason: "local_missing", phase: "readback", retryable: false },
          };
        }

        const matchedIdentity = isNumericId
          ? record.id !== null && String(record.id) === safeOrderId
          : record.reference_id === safeOrderId;
        if (!matchedIdentity) {
          return {
            kind: "unknown",
            refusal: { reason: "malformed", phase: "readback", retryable: false },
          };
        }

        const built = buildObservationFromOrderRecord({
          record,
          source: "provider_response",
          receivedAt: options.clock(),
          externalRefOverride: safeOrderId,
          correlationOverride: { fulfillmentRef: input.fulfillmentRef },
          approveTrackingUrl: options.approveTrackingUrl,
          observationCodecs: options.observationCodecs,
        });
        if (built.kind === "unmapped") {
          return {
            kind: "unknown",
            refusal: { reason: "unsupported_event", phase: "readback", retryable: false },
          };
        }
        return built;
      } catch (error) {
        const opError = toOperationError(error, false);
        return {
          kind: "unknown",
          refusal: { reason: "io_failure", phase: "readback", retryable: opError.retryable },
        };
      }
    },
  };

  const reconciliation: FulfillmentObservationPagePort = {
    async readPage(input) {
      if (
        !Number.isSafeInteger(input.page) ||
        input.page < 0 ||
        !Number.isSafeInteger(input.size) ||
        input.size <= 0
      ) {
        return {
          kind: "failed",
          refusal: { reason: "malformed", phase: "readback", retryable: false },
        };
      }

      if (input.page === 0) {
        exhaustedAtPage = null;
      } else if (exhaustedAtPage !== null && input.page > exhaustedAtPage) {
        return { kind: "page_exhausted" };
      }

      let orders: readonly ShipBobOrderRecord[];
      try {
        orders = await options.client.listOrders({
          page: input.page + 1,
          limit: input.size,
        });
      } catch (error) {
        const opError = toOperationError(error, false);
        return {
          kind: "failed",
          refusal: { reason: "io_failure", phase: "readback", retryable: opError.retryable },
          error: opError,
        };
      }

      if (orders.length === 0) {
        exhaustedAtPage = input.page;
        return { kind: "page", rows: [] };
      }

      const receivedAt = options.clock();
      const rows = orders.map((record) =>
        buildObservationFromOrderRecord({
          record,
          source: "provider_reconciliation",
          receivedAt,
          approveTrackingUrl: options.approveTrackingUrl,
          observationCodecs: options.observationCodecs,
        }),
      );
      return { kind: "page", rows };
    },
  };

  const stockSync: FulfillmentStockSyncProvider = {
    async getStock() {
      const collectedAt = options.clock();
      const syncRunId = `shipbob_sync_${collectedAt.replace(/[^0-9]/gu, "").slice(0, 14) || "0"}`;
      const results: (StockSnapshot | { kind: "rejected"; itemIndex: number; reason: "invalid_sku_ref" })[] =
        [];
      let itemIndex = 0;

      for (let page = 1; page <= MAX_INVENTORY_PAGES; page += 1) {
        let items;
        try {
          items = await options.client.listInventory({
            page,
            limit: inventoryPageSize,
          });
        } catch (error) {
          const opError = toOperationError(error, false);
          throw {
            reason: "io_failure" as const,
            phase: "sync" as const,
            retryable: opError.retryable,
            providerFailure: true,
            status: opError.status,
            code: opError.code,
            providerError: {
              operation: "get_stock" as const,
              status: opError.status,
              code: opError.code,
              retryable: opError.retryable,
            },
          };
        }

        if (items.length === 0) {
          break;
        }

        for (const item of items) {
          const skuRef = safeRef(item.sku);
          if (!skuRef) {
            results.push({ kind: "rejected", itemIndex, reason: "invalid_sku_ref" });
          } else {
            const onHand =
              typeof item.total_on_hand_quantity === "number" &&
              Number.isSafeInteger(item.total_on_hand_quantity) &&
              item.total_on_hand_quantity >= 0
                ? item.total_on_hand_quantity
                : 0;
            const forSaleQuantity =
              typeof item.total_fulfillable_quantity === "number" &&
              Number.isSafeInteger(item.total_fulfillable_quantity) &&
              item.total_fulfillable_quantity >= 0
                ? item.total_fulfillable_quantity
                : 0;
            const totalQuantity = Math.max(onHand, forSaleQuantity);
            const reservedOrUnavailableQuantity = Math.max(0, totalQuantity - forSaleQuantity);
            const sourceRevision = safeRfc3339(item.last_updated_date);
            results.push({
              providerRef: SHIPBOB_PROVIDER_REF,
              syncRunId,
              collectedAt,
              sourceRevision,
              revisionSource: sourceRevision ? "provider" : "collection",
              skuRef,
              quantityKind: "snapshot",
              totalQuantity,
              forSaleQuantity,
              reservedOrUnavailableQuantity,
            });
          }
          itemIndex += 1;
        }

        if (items.length < inventoryPageSize) {
          break;
        }
      }

      return results;
    },

    async getStockMovements() {
      const refusal: FulfillmentRefusal = {
        reason: "stock_movements_unsupported",
        phase: "sync",
        retryable: false,
      };
      throw refusal;
    },
  };

  const label: FulfillmentLabelPort = {
    async create() {
      return {
        kind: "refused",
        refusal: { reason: "unsupported", phase: "dispatch", retryable: false },
      };
    },
    async read() {
      return {
        kind: "refused",
        refusal: { reason: "unsupported", phase: "dispatch", retryable: false },
      };
    },
    async void() {
      return {
        providerDeletion: "unconfirmed",
        labelDeleted: false,
        canProceed: false,
        refusal: { reason: "unsupported", phase: "dispatch", retryable: false },
      };
    },
  };

  const productSync: FulfillmentProductSyncProvider = {
    async ensureProduct() {
      const refusal: FulfillmentRefusal = { reason: "unsupported", phase: "sync", retryable: false };
      throw refusal;
    },
    async getProductPacks() {
      const refusal: FulfillmentRefusal = { reason: "unsupported", phase: "sync", retryable: false };
      throw refusal;
    },
    async addProductPack() {
      const refusal: FulfillmentRefusal = { reason: "unsupported", phase: "sync", retryable: false };
      throw refusal;
    },
    async listStockedSkus() {
      const refusal: FulfillmentRefusal = { reason: "unsupported", phase: "sync", retryable: false };
      throw refusal;
    },
  };

  return {
    capabilities,
    dispatch,
    observation,
    readback,
    reconciliation,
    stockSync,
    label,
    productSync,
  };
}
