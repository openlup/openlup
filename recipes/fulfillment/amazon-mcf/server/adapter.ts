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
  AmazonMcfTransportError,
  assertSafeAmazonMcfOrderId,
  sanitizeDiagnosticCode,
  type AmazonMcfClient,
  type AmazonMcfCreateOrderPayload,
  type AmazonMcfOrderRecord,
} from "./client-contract.js";
import {
  AMAZON_MCF_MAPPER_VERSION,
  AMAZON_MCF_PROVIDER_REF,
  buildNormalizedTrackingRefs,
  createAmazonMcfWebhookVerifier,
  deterministicEvidenceReference,
  mapAmazonMcfStatus,
  resolveAmazonMcfAggregateShipmentStatus,
} from "./webhook.js";

const SAFE_REF_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/u;
const RFC3339_OFFSET_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const MAX_PREPARED_ENTRIES = 2048;
const MAX_OUTCOME_ENTRIES = 2048;
const MAX_INVENTORY_PAGES = 100;

/**
 * Static default-off capability descriptor for Amazon Multi-Channel Fulfillment (SP-API v2020-07-01).
 * Never mutated; `createAmazonMcfFulfillmentAdapter` clones this descriptor per instance.
 */
export const amazonMcfFulfillmentCapabilities: Readonly<FulfillmentCapabilityDescriptor> = Object.freeze({
  providerRef: AMAZON_MCF_PROVIDER_REF,
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
export function projectAmazonMcfStaticCapabilities(): FulfillmentCapabilityDescriptor {
  return JSON.parse(JSON.stringify(amazonMcfFulfillmentCapabilities)) as FulfillmentCapabilityDescriptor;
}

export interface CreateAmazonMcfFulfillmentAdapterOptions {
  readonly client: AmazonMcfClient;
  readonly marketplaceId: string;
  readonly webhookSigningSecrets: readonly string[];
  readonly clock: () => string;
  readonly selected?: boolean;
  readonly ready?: boolean;
  readonly approveTrackingUrl?: (url: string) => boolean;
  readonly observationCodecs?: FulfillmentObservationCodecs;
  readonly maxTimestampSkewMs?: number;
  readonly displayableOrderComment?: string;
  readonly defaultShippingSpeed?: "Standard" | "Expedited" | "Priority";
}

interface PreparedCommandEntry {
  readonly requestKey: string;
  readonly fulfillmentRef: string;
  readonly sellerOrderId: string;
  readonly command: AmazonMcfCreateOrderPayload;
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

function resolveShippingSpeed(
  serviceRef: string | null,
  fallback: "Standard" | "Expedited" | "Priority",
): "Standard" | "Expedited" | "Priority" {
  const normalized = serviceRef?.trim().toLowerCase() ?? "";
  if (normalized === "priority" || normalized === "mcf_priority") return "Priority";
  if (normalized === "expedited" || normalized === "mcf_expedited") return "Expedited";
  if (normalized === "standard" || normalized === "mcf_standard") return "Standard";
  return fallback;
}

function buildSellerOrderId(request: FulfillmentDispatchRequest): string | null {
  const candidate = (request.parcelRef ?? request.fulfillmentRef).trim();
  if (!candidate || candidate.length > 40 || !SAFE_REF_REGEX.test(candidate)) {
    return null;
  }
  return candidate;
}

function toOperationError(
  error: unknown,
  defaultMayHaveSucceeded: boolean,
): FulfillmentOperationError {
  if (error instanceof AmazonMcfTransportError) {
    return {
      code: sanitizeDiagnosticCode(error.code, "amazon_mcf_operation_failed"),
      status: error.status,
      retryable: error.retryable,
      mayHaveSucceeded: error.mayHaveSucceeded,
      submissionAttempted: error.submissionAttempted,
      responseBodyRead: error.responseBodyRead,
    };
  }
  return {
    code: "amazon_mcf_transport_error",
    status: null,
    retryable: true,
    mayHaveSucceeded: defaultMayHaveSucceeded,
    submissionAttempted: defaultMayHaveSucceeded,
    responseBodyRead: false,
  };
}

function buildObservationFromOrderRecord(params: {
  readonly record: AmazonMcfOrderRecord;
  readonly source: "provider_response" | "provider_reconciliation";
  readonly receivedAt: string;
  readonly correlationOverride?: {
    readonly fulfillmentRef?: string | null;
  };
  readonly approveTrackingUrl?: (url: string) => boolean;
  readonly observationCodecs?: FulfillmentObservationCodecs;
}): FulfillmentReconciliationObservation {
  const externalRef = safeRef(params.record.sellerFulfillmentOrderId);
  const shipments = params.record.fulfillmentShipments ?? [];
  const latestShipment = shipments.length > 0 ? shipments[shipments.length - 1] : undefined;
  const shipmentStatus = resolveAmazonMcfAggregateShipmentStatus(shipments);
  const mapped = mapAmazonMcfStatus(params.record.fulfillmentOrderStatus, shipmentStatus);

  const occurredAt =
    safeRfc3339(params.record.statusUpdatedDate) ??
    safeRfc3339(latestShipment?.shippingDate) ??
    safeRfc3339(params.record.receivedDate) ??
    params.receivedAt;
  const createdAt = safeRfc3339(params.record.receivedDate);
  const updatedAt = safeRfc3339(params.record.statusUpdatedDate) ?? occurredAt;

  const canonicalSnapshot = JSON.stringify({
    sellerFulfillmentOrderId: params.record.sellerFulfillmentOrderId,
    fulfillmentOrderStatus: params.record.fulfillmentOrderStatus,
    shipmentStatus,
    updatedAt,
  });
  const digest = createHash("sha256").update(canonicalSnapshot, "utf8").digest("hex");
  const rawRef = deterministicEvidenceReference(digest);

  const primaryStatus = safeRef(params.record.fulfillmentOrderStatus);
  const subStatus = safeRef(shipmentStatus);
  const orderNumber = safeRef(params.record.displayableOrderId);
  const providerFulfillmentRef = safeRef(latestShipment?.amazonShipmentId) ?? externalRef;
  const fulfillmentRef = safeRef(params.correlationOverride?.fulfillmentRef) ?? null;

  const correlation: FulfillmentObservation["correlation"] = {
    orderRef: null,
    fulfillmentRef,
    externalRef,
    orderNumber,
    providerFulfillmentRef,
    parcelRef: null,
  };

  if (!externalRef || !mapped) {
    const unmappedEventKey = `amazon_mcf:unmapped:${externalRef ?? "unknown"}:${digest.slice(0, 16)}`;
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

  const occurrenceKey = `mcf_rb_${digest.slice(0, 24)}`;
  const eventKey = `amazon_mcf:${externalRef}:${mapped.eventKind}:${mapped.canonicalStatus}:${occurredAt}:${occurrenceKey}`;
  const factId = `mcf_fact_${createHash("sha256").update(eventKey).digest("hex").slice(0, 24)}`;

  const rawPackages = (params.record.fulfillmentShipments ?? []).flatMap(
    (shipment) => shipment.fulfillmentShipmentPackage ?? [],
  );
  const tracking = buildNormalizedTrackingRefs({
    rawTracking: rawPackages,
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
      mapperVersion: AMAZON_MCF_MAPPER_VERSION,
      factId,
      providerKind: AMAZON_MCF_PROVIDER_REF,
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
 * Create a complete, zero-SDK Amazon Multi-Channel Fulfillment (`amazon_mcf`)
 * `FulfillmentProviderAdapter` implementing dispatch, bridged webhook verification,
 * exact readback, `nextToken`-mapped reconciliation paging, snapshot-only stock sync,
 * and explicit zero-I/O refusals for unsupported ports (`label`, `productSync`, `stockMovements`).
 */
export function createAmazonMcfFulfillmentAdapter(
  options: CreateAmazonMcfFulfillmentAdapterOptions,
): FulfillmentProviderAdapter {
  const marketplaceId = options.marketplaceId.trim();
  if (!marketplaceId || !SAFE_REF_REGEX.test(marketplaceId)) {
    throw new Error("amazon_mcf_marketplace_id_invalid");
  }

  const defaultShippingSpeed = options.defaultShippingSpeed ?? "Standard";
  const displayableOrderComment = (options.displayableOrderComment ?? "Order fulfillment").trim() || "Order fulfillment";

  const baseCaps = projectAmazonMcfStaticCapabilities();
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
  interface PaginationState {
    readonly expectedPage: number;
    readonly buffer: AmazonMcfOrderRecord[];
    readonly nextToken: string | null;
    readonly exhausted: boolean;
  }
  let paginationState: PaginationState | null = null;
  const MAX_RECONCILIATION_BUFFER = 2048;

  const dispatch: FulfillmentDispatchPort = {
    async prepare(request) {
      if (!request.selection.providerRef) {
        return {
          kind: "refused",
          refusal: { reason: "selection_required", phase: "selection", retryable: false },
        };
      }
      if (request.selection.providerRef !== AMAZON_MCF_PROVIDER_REF) {
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

      const sellerOrderId = buildSellerOrderId(request);
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

      if (!sellerOrderId || !request.requestKey.trim() || !validLines || !validAddress) {
        return {
          kind: "refused",
          refusal: { reason: "not_dispatchable", phase: "prepare", retryable: false },
        };
      }

      const displayableOrderId = (request.orderNumber?.trim() || request.orderRef.trim()).slice(0, 40);
      const line2 = request.recipient.line2?.trim() || undefined;
      const phone = request.recipient.phone?.trim() || undefined;
      const email = request.recipient.email?.trim() || undefined;

      const command: AmazonMcfCreateOrderPayload = {
        marketplaceId,
        sellerFulfillmentOrderId: sellerOrderId,
        displayableOrderId,
        displayableOrderDate: options.clock(),
        displayableOrderComment,
        shippingSpeedCategory: resolveShippingSpeed(request.selection.serviceRef, defaultShippingSpeed),
        destinationAddress: {
          name: request.recipient.name?.trim() || "Recipient",
          addressLine1: line1,
          ...(line2 ? { addressLine2: line2 } : {}),
          city,
          postalCode,
          countryCode: country,
          ...(phone ? { phone } : {}),
        },
        ...(email ? { notificationEmails: [email] } : {}),
        items: request.lines.map((line, index) => ({
          sellerSku: line.skuRef.trim(),
          sellerFulfillmentOrderItemId: `${sellerOrderId}-${index + 1}`.slice(0, 50),
          quantity: line.quantity,
        })),
      };

      // Hash deterministic command bytes (excluding volatile displayableOrderDate) so prepare() is
      // idempotent across clock ticks and retained unknown/accepted outcomes stay reachable.
      const { displayableOrderDate: _volatileDate, ...deterministicCommand } = command;
      const commandFingerprint = createHash("sha256")
        .update(JSON.stringify(deterministicCommand), "utf8")
        .digest("hex");

      // Sanitize durable transcript allowlist identically to `dispatchEvidence`.
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
        providerRef: AMAZON_MCF_PROVIDER_REF,
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
          sellerOrderId,
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
        await options.client.createFulfillmentOrder(prepared.command);
        const receiptKey = `amazon_mcf:receipt:${prepared.sellerOrderId}`;
        const accepted: FulfillmentDispatchResult = {
          kind: "accepted",
          externalRef: prepared.sellerOrderId,
          evidence: cloneResult(prepared.evidence),
          providerAttemptKey: `amazon_mcf:attempt:${evidence.commandFingerprint.slice(0, 24)}`,
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

  const observation = createAmazonMcfWebhookVerifier({
    signingSecrets: options.webhookSigningSecrets,
    approveTrackingUrl: options.approveTrackingUrl,
    observationCodecs: options.observationCodecs,
    maxTimestampSkewMs: options.maxTimestampSkewMs,
  });

  const readback: FulfillmentReadbackPort = {
    async read(input): Promise<FulfillmentReadbackResult> {
      if (input.providerRef !== AMAZON_MCF_PROVIDER_REF) {
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
        safeOrderId = assertSafeAmazonMcfOrderId(input.externalRef);
      } catch {
        return {
          kind: "unknown",
          refusal: { reason: "malformed", phase: "readback", retryable: false },
        };
      }
      try {
        const record = await options.client.getFulfillmentOrder(safeOrderId);
        if (!record) {
          // SP-API is eventually consistent; 404 never certifies authoritative absence.
          return {
            kind: "unknown",
            refusal: { reason: "local_missing", phase: "readback", retryable: false },
          };
        }
        const built = buildObservationFromOrderRecord({
          record,
          source: "provider_response",
          receivedAt: options.clock(),
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
      if (!Number.isSafeInteger(input.page) || input.page < 0 || !Number.isSafeInteger(input.size) || input.size <= 0) {
        return {
          kind: "failed",
          refusal: { reason: "malformed", phase: "readback", retryable: false },
        };
      }

      if (input.page === 0) {
        paginationState = null;
      } else if (!paginationState || input.page !== paginationState.expectedPage) {
        return { kind: "page_exhausted" };
      }

      const buffer: AmazonMcfOrderRecord[] = paginationState ? [...paginationState.buffer] : [];
      let nextToken: string | null = paginationState ? paginationState.nextToken : null;
      let exhausted = paginationState ? paginationState.exhausted : false;

      // If no buffered rows remain and SP-API already signaled end-of-stream, report page_exhausted at 0 I/O.
      if (input.page > 0 && buffer.length === 0 && exhausted) {
        return { kind: "page_exhausted" };
      }

      // Fetch from SP-API only when buffer has fewer rows than requested and stream is not exhausted.
      if (buffer.length < input.size && !exhausted) {
        try {
          const response = await options.client.listAllFulfillmentOrders({ nextToken });
          for (const order of response.fulfillmentOrders) {
            if (buffer.length >= MAX_RECONCILIATION_BUFFER) break;
            buffer.push(order);
          }
          nextToken = response.nextToken;
          exhausted = nextToken === null;
        } catch (error) {
          const opError = toOperationError(error, false);
          return {
            kind: "failed",
            refusal: { reason: "io_failure", phase: "readback", retryable: opError.retryable },
            error: opError,
          };
        }
      }

      const pageRecords = buffer.splice(0, input.size);
      paginationState = {
        expectedPage: input.page + 1,
        buffer,
        nextToken,
        exhausted,
      };

      const receivedAt = options.clock();
      const rows = pageRecords.map((record) =>
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
      const syncRunId = `amazon_mcf_sync_${collectedAt.replace(/[^0-9]/gu, "").slice(0, 14) || "0"}`;
      const results: (StockSnapshot | { kind: "rejected"; itemIndex: number; reason: "invalid_sku_ref" })[] = [];

      let nextToken: string | null = null;
      let itemIndex = 0;

      for (let page = 0; page < MAX_INVENTORY_PAGES; page += 1) {
        let response;
        try {
          response = await options.client.listInventorySummaries({
            marketplaceId,
            nextToken,
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

        for (const summary of response.inventorySummaries) {
          const skuRef = safeRef(summary.sellerSku);
          if (!skuRef) {
            results.push({ kind: "rejected", itemIndex, reason: "invalid_sku_ref" });
          } else {
            const sourceRevision = safeRfc3339(summary.lastUpdatedTime);
            results.push({
              providerRef: AMAZON_MCF_PROVIDER_REF,
              syncRunId,
              collectedAt,
              sourceRevision,
              revisionSource: sourceRevision ? "provider" : "collection",
              skuRef,
              quantityKind: "snapshot",
              totalQuantity: summary.totalQuantity,
              forSaleQuantity: summary.fulfillableQuantity,
              reservedOrUnavailableQuantity: summary.reservedQuantity + summary.unfulfillableQuantity,
            });
          }
          itemIndex += 1;
        }

        if (!response.nextToken) {
          break;
        }
        nextToken = response.nextToken;
      }

      return results;
    },

    async getStockMovements() {
      // SP-API FBA Inventory v1 is snapshot-only; never throw generic `unsupported` when `syncStock.supported === true`.
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
