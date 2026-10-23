import type { DispatchEvidence, FulfillmentCapabilityDescriptor, FulfillmentDispatchPort, FulfillmentDispatchRequest,
  FulfillmentLabelPort, FulfillmentObservationPort, FulfillmentReadbackPort, FulfillmentObservationPagePort, FulfillmentStockSyncProvider, FulfillmentProductSyncProvider, FulfillmentRefusal } from "../contracts/index.js";
import { createOmnipackClient, OmnipackProviderError } from "./client.js";
import { omnipackFulfillmentCapabilities } from "./capabilities.js";
import { buildOmnipackDispatchCommand, serializeOmnipackDispatchPayload, stableDispatchHash } from "./omnipackDispatchPayload.js";
import { mapOmnipackWebhookPayload } from "./mappers.js";
import { verifyOmnipackWebhookToken, type OmnipackWebhookRouteEvent } from "./omnipackWebhookPayload.js";
import { createReconciliationPagePort, reconciliationObservation } from "./reconciliation.js";
import { dispatchEvidence, operationError } from "../dispatchProjection.js";
import { digest, eventKind, observation, reference, refusal, timestamp } from "./observation.js";
export { omnipackFulfillmentCapabilities } from "./capabilities.js";

// Internal error projection: retain diagnostics without exposing a provider payload or cause.
class OmnipackSyncError extends Error implements FulfillmentRefusal {
  readonly phase = "sync";
  readonly retryable: boolean;
  readonly providerFailure: boolean;
  readonly status: number | null;
  readonly code: string | null;

  constructor(readonly reason: FulfillmentRefusal["reason"], operation: string, error?: unknown) {
    super(reason === "io_failure" ? `OmniPack request failed: ${operation}` : `OmniPack sync refused: ${reason}`);
    this.name = "OmnipackSyncError";
    this.providerFailure = reason === "io_failure";
    this.retryable = error instanceof OmnipackProviderError ? error.retryable : false;
    this.status = error instanceof OmnipackProviderError ? error.status : null;
    this.code = error instanceof OmnipackProviderError ? error.code : null;
  }
}
function syncFailure(operation: string, error: unknown): OmnipackSyncError {
  return error instanceof OmnipackSyncError ? error : new OmnipackSyncError("io_failure", operation, error);
}
function requireProductSku(sku: string): void {
  // URL resolution collapses dot segments; encodeURIComponent rejects lone surrogates.
  // Keep these SKUs in the listing so the worker counts a visible per-SKU failure.
  try {
    if (!sku.trim() || sku === "." || sku === "..") throw Error();
    encodeURIComponent(sku);
  } catch { throw new OmnipackSyncError("malformed", "getProduct"); }
}

/** Node-only, explicit construction. Secrets are supplied per call, never retained as values. */
export interface OmnipackFulfillmentAdapterConfig {
  http: {
    baseUrl: string; credentials: () => { username: string; password: string } | Promise<{ username: string; password: string }>;
    fetchImpl: typeof fetch; timeoutMs: number; safeReadRetries: number; productPath: string;
  };
  selected?: boolean;
  /** Per-instance retention target; default 10,000. Evicts oldest completed submissions, never in-flight. */
  maxRetainedSubmissions?: number;
  /** Host account evidence, independent of credentials. Omission remains not ready. */
  readiness?: FulfillmentCapabilityDescriptor["readiness"];
  /** Called in prepare and again for new dispatches; return identical metadata for the same request or dispatch refuses. */
  resolveProduct: (line: FulfillmentDispatchRequest["lines"][number]) => Promise<{ lotNumber?: string; expirationDate?: string } | null>;
  notification: { token: () => string | undefined | Promise<string | undefined>; expectedEvent: OmnipackWebhookRouteEvent };
  clock: () => string;
  mintEvidenceReference: () => `evidence:${string}`;
  mintSyncRunId: () => string;
  approveTrackingUrl: (url: string) => boolean;
  /** Writes occur only through deliberate calls; scheduled composition must remain pull-only. */
  product?: { resolvePushMetadata: (sku: string) => Promise<Record<string, unknown> | null> };
}

/** No route, schedule, environment reader or default binding is installed. */
export function createOmnipackFulfillmentAdapter(config: OmnipackFulfillmentAdapterConfig): {
  capabilities: FulfillmentCapabilityDescriptor;
  dispatch: FulfillmentDispatchPort;
  label: FulfillmentLabelPort;
  observation: FulfillmentObservationPort;
  readback: FulfillmentReadbackPort;
  reconciliation: FulfillmentObservationPagePort;
  stockSync: FulfillmentStockSyncProvider;
  productSync: FulfillmentProductSyncProvider;
} {
  const maxRetainedSubmissions = config.maxRetainedSubmissions === undefined ? 10_000 : config.maxRetainedSubmissions;
  const base = new URL(config.http.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash
    || !Number.isSafeInteger(maxRetainedSubmissions) || maxRetainedSubmissions <= 0
    || typeof config.http.fetchImpl !== "function" || typeof config.http.credentials !== "function"
    || !Number.isSafeInteger(config.http.timeoutMs) || config.http.timeoutMs <= 0
    || !Number.isSafeInteger(config.http.safeReadRetries) || config.http.safeReadRetries < 0
    || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?$/u.test(config.http.productPath)
    || !eventKind(config.notification.expectedEvent)) throw new Error("Invalid fulfillment configuration");
  const client = createOmnipackClient({ ...config.http }, config.http.fetchImpl);
  // Copy the profile so host selection never mutates the exported default-off descriptor.
  const capabilities: FulfillmentCapabilityDescriptor = structuredClone(omnipackFulfillmentCapabilities);
  capabilities.selected = config.selected === true;
  capabilities.readiness = config.readiness?.ready === true ? { ready: true }
    : { ready: false, refusal: refusal("not_ready", "selection") };
  const submissions = new Map<string, { evidenceKey: string; commandDigest: string; completed: boolean; result: ReturnType<FulfillmentDispatchPort["dispatch"]> }>();
  const evictCompleted = () => {
    for (const [fingerprint, submission] of submissions) {
      if (submissions.size <= maxRetainedSubmissions) break;
      if (submission.completed) submissions.delete(fingerprint);
    }
  };
  const selectionFailure = (request: FulfillmentDispatchRequest) => {
    if (!request.selection?.providerRef?.trim()) return refusal("selection_required", "selection");
    if (request.selection.providerRef !== capabilities.providerRef) return refusal("provider_mismatch", "selection");
    if (!reference(request.selection.carrierRef) || !reference(request.selection.serviceRef)) return refusal("carrier_service_required", "selection");
    if (!capabilities.selected) return refusal("disabled", "selection");
    if (!capabilities.readiness.ready) return refusal("not_ready", "selection");
    return null;
  };
  const requireSync = () => {
    if (!capabilities.selected || !capabilities.readiness.ready) throw new OmnipackSyncError(capabilities.selected ? "not_ready" : "disabled", "selection");
  };
  const syncIdentity = () => {
    const syncRunId = reference(config.mintSyncRunId());
    const collectedAt = timestamp(config.clock());
    if (!syncRunId || !collectedAt) throw new OmnipackSyncError("malformed", "sync");
    return { providerRef: capabilities.providerRef, syncRunId, collectedAt, sourceRevision: null, revisionSource: "collection" as const };
  };
  // Shared computation: host metadata and serialized bytes live only for this call.
  const buildCommand = async (request: FulfillmentDispatchRequest) => {
    const requestDigest = stableDispatchHash(request);
    if (!Number.isSafeInteger(request.contactRevision.schemaVersion) || request.contactRevision.schemaVersion < 1
      || !reference(request.contactRevision.source) || !Number.isSafeInteger(request.contactRevision.revision)
      || request.contactRevision.revision < 0) throw Error();
    const lines = [];
    for (const line of request.lines) {
      const metadata = await config.resolveProduct(line);
      if (!metadata) throw Error();
      lines.push({ sku: line.skuRef, quantity: line.quantity, productSnapshot: { lotNumber: metadata.lotNumber, expirationDate: metadata.expirationDate } });
    }
    if (stableDispatchHash(request) !== requestDigest) throw Error();
    const command = buildOmnipackDispatchCommand({
      orderId: request.orderRef, orderNumber: request.orderNumber,
      deliveryContact: { revision: request.contactRevision.revision, recipientName: request.recipient.name,
        contactEmail: request.recipient.email, contactPhone: request.recipient.phone, line1: request.recipient.line1,
        city: request.recipient.city, postalCode: request.recipient.postalCode, country: request.recipient.country,
        selectedDelivery: { providerKind: capabilities.providerRef, carrierKind: request.selection.carrierRef,
          serviceCode: request.selection.serviceRef, deliveryKind: request.selection.deliveryKind, pickupPoint: request.selection.pickupPoint } }, lines,
    });
    const evidence: DispatchEvidence = dispatchEvidence({ commandFingerprint: command.requestFingerprint,
      contactRevision: { schemaVersion: request.contactRevision.schemaVersion, source: request.contactRevision.source, revision: request.contactRevision.revision },
      providerRef: capabilities.providerRef, carrierRef: request.selection.carrierRef, serviceRef: request.selection.serviceRef,
      transcript: { itemCount: command.providerPayload.items.length,
        items: command.providerPayload.items.map(item => ({ skuRef: item.sku, quantity: item.quantity, lotRef: item.lotNumber ?? null, expirationDate: item.expirationDate ?? null })),
        deliveryKind: request.selection.deliveryKind, pickupPointRef: request.selection.pickupPoint?.id ?? null } });
    return { body: command.body, evidence };
  };
  return {
    capabilities,
    dispatch: {
      async prepare(request) {
        const failed = selectionFailure(request);
        if (failed) return { kind: "refused", refusal: failed };
        try { return { kind: "prepared", evidence: (await buildCommand(request)).evidence }; }
        catch { return { kind: "refused", refusal: refusal("not_dispatchable", "prepare") }; }
      },
      async dispatch(request, evidence) {
        let commandRequest: FulfillmentDispatchRequest;
        let fingerprint: string;
        let evidenceKey: string;
        let requestCommandDigest: string;
        try {
          // Validate the closed evidence and its request-bound values without consulting preparation state.
          if (Object.keys(evidence).length !== 6 || Object.keys(evidence.contactRevision).length !== 3
            || typeof evidence.commandFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(evidence.commandFingerprint)
            || !reference(evidence.providerRef)
            || !reference(evidence.carrierRef) || !reference(evidence.serviceRef)
            || !Number.isSafeInteger(evidence.contactRevision.schemaVersion) || evidence.contactRevision.schemaVersion < 1
            || !reference(evidence.contactRevision.source) || !Number.isSafeInteger(evidence.contactRevision.revision)
            || evidence.contactRevision.revision < 0
            || evidence.contactRevision.schemaVersion !== request.contactRevision.schemaVersion
            || evidence.contactRevision.source !== request.contactRevision.source
            || evidence.contactRevision.revision !== request.contactRevision.revision
            || evidence.providerRef !== request.selection.providerRef
            || evidence.carrierRef !== request.selection.carrierRef || evidence.serviceRef !== request.selection.serviceRef) throw Error();
          evidenceKey = serializeOmnipackDispatchPayload(evidence).body;
          if (serializeOmnipackDispatchPayload(dispatchEvidence(evidence)).body !== evidenceKey) throw Error();
          requestCommandDigest = commandDigest(request);
          const submitted = submissions.get(evidence.commandFingerprint);
          if (submitted) {
            // Replay is bound to this submission's evidence and command, never replaceable preparation.
            if (submitted.evidenceKey !== evidenceKey || submitted.commandDigest !== requestCommandDigest) throw Error();
            return structuredClone(await submitted.result);
          }
          if (selectionFailure(request)) throw Error();
          commandRequest = structuredClone(request);
          fingerprint = evidence.commandFingerprint;
        } catch { return { kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: refusal("not_dispatchable", "dispatch") }; }
        // Reserve before host resolution too, so concurrent dispatches join the rebuild.
        const result = Promise.resolve().then(async () => {
          let command;
          try {
            command = await buildCommand(commandRequest);
            if (command.evidence.commandFingerprint !== fingerprint || serializeOmnipackDispatchPayload(command.evidence).body !== evidenceKey) throw Error();
          } catch {
            // A stale or unresolved command has never reached credentials or HTTP.
            submissions.delete(fingerprint);
            return { kind: "not_dispatched" as const, effectMayHaveSucceeded: false as const, refusal: refusal("not_dispatchable", "dispatch") };
          }
          try {
            const result = await client.createOrder(command.body);
            const externalRef = reference(result.providerOrderId);
            if (!externalRef) return { kind: "unknown" as const, effectMayHaveSucceeded: true as const, refusal: refusal("malformed", "acknowledge") };
            // Opaque provider proof; the worker replaces these with authoritative host keys.
            const proof = digest(JSON.stringify([externalRef, command.evidence.commandFingerprint]));
            return { kind: "accepted" as const, externalRef, evidence: structuredClone(command.evidence),
              providerAttemptKey: `attempt:${proof}`, labelKey: `label:${proof}` };
          } catch (error) {
            const detail = operationError(error instanceof OmnipackProviderError ? error : { code: "provider_dispatch_failed", status: null, retryable: true, mayHaveSucceeded: true });
            return !detail.mayHaveSucceeded
              ? { kind: "not_dispatched" as const, effectMayHaveSucceeded: false as const, refusal: refusal("io_failure", "dispatch", detail.retryable), error: detail }
              : { kind: "unknown" as const, effectMayHaveSucceeded: true as const, refusal: refusal("io_failure", "dispatch", detail.retryable), error: detail };
          } finally {
            command.body = "";
            submissions.get(fingerprint)!.completed = true;
            evictCompleted();
          }
        });
        submissions.set(fingerprint, { evidenceKey, commandDigest: requestCommandDigest, completed: false, result });
        evictCompleted();
        return structuredClone(await result);
      },
    },
    label: {
      async create() { return { kind: "refused", refusal: refusal("unsupported", "dispatch") }; },
      async read() { return { kind: "refused", refusal: refusal("unsupported", "dispatch") }; },
      async void() { return { providerDeletion: "unconfirmed", labelDeleted: false, canProceed: false, refusal: refusal("unsupported", "dispatch") }; },
    },
    observation: {
      async verifyAndNormalize(input) {
        // Token check precedes every read of rawBody and every parse.
        try {
          if (!verifyOmnipackWebhookToken({ headers: { ...input.headers } }, await config.notification.token()))
            return { kind: "refused", refusal: refusal("untrusted", "verify") };
        } catch { return { kind: "refused", refusal: refusal("untrusted", "verify") }; }
        try {
          const rawBody = Buffer.from(input.rawBody);
          const payload: unknown = JSON.parse(rawBody.toString("utf8"));
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { kind: "refused", refusal: refusal("malformed", "normalize") };
          if ("event" in payload && (typeof payload.event !== "string" || !eventKind(payload.event)))
            return { kind: "refused", refusal: refusal("unsupported_event", "normalize") };
          const evidence = mapOmnipackWebhookPayload(payload, config.notification.expectedEvent);
          const event = eventKind(evidence.event);
          if (!event || event !== config.notification.expectedEvent) return { kind: "refused", refusal: refusal("unsupported_event", "normalize") };
          if (![evidence.providerOrderId, evidence.orderNumber, evidence.fulfilmentNumber].some(value => reference(value)))
            return { kind: "refused", refusal: refusal("missing_correlation", "normalize") };
          return { kind: "verified", observation: observation({ evidence, event, receivedAt: input.receivedAt,
            rawDigest: digest(rawBody), evidenceRef: config.mintEvidenceReference(), source: "provider_webhook", approveTrackingUrl: config.approveTrackingUrl }) };
        } catch { return { kind: "refused", refusal: refusal("malformed", "normalize") }; }
      },
    },
    readback: {
      async read(input) {
        if (input.providerRef !== capabilities.providerRef) return { kind: "unsupported", refusal: refusal("provider_mismatch", "readback") };
        if (!capabilities.selected || !capabilities.readiness.ready) return { kind: "unsupported", refusal: refusal(capabilities.selected ? "not_ready" : "disabled", "readback") };
        if (!reference(input.externalRef)) return { kind: "unsupported", refusal: refusal("unsupported", "readback") };
        try {
          const collection = await client.getFulfilmentsPage({ page: 0, size: 100 });
          if (!collection.complete) return { kind: "unknown", refusal: refusal("local_missing", "readback") };
          const matches = collection.rows.filter(row => input.mode === "parcel"
            ? row.fulfilmentNumber === input.externalRef : row.providerOrderId === input.externalRef);
          if (matches.length !== 1) return { kind: "unknown", refusal: refusal("local_missing", "readback") };
          const mapped = reconciliationObservation(matches[0]!, config, input.fulfillmentRef);
          return mapped.kind === "unmapped" ? { kind: "unknown", refusal: refusal("unsupported_event", "readback") } : { ...mapped, externalRef: input.externalRef! };
        } catch { return { kind: "unknown", refusal: refusal("io_failure", "readback") }; }
      },
    },
    reconciliation: createReconciliationPagePort(client, config, () => !capabilities.selected || !capabilities.readiness.ready
      ? refusal(capabilities.selected ? "not_ready" : "disabled", "readback") : null),
    stockSync: {
      async getStock() {
        requireSync();
        try {
          const identity = syncIdentity();
          return (await client.getStock({ refuseRedirectRetry: true })).map((row, itemIndex) => {
            const skuRef = reference(row.sku);
            if (!skuRef) return { kind: "rejected" as const, itemIndex, reason: "invalid_sku_ref" as const };
            return { ...identity, skuRef, quantityKind: "snapshot" as const, totalQuantity: row.totalQuantity,
              forSaleQuantity: row.forSaleQuantity, reservedOrUnavailableQuantity: row.reservedOrUnavailableQuantity };
          });
        } catch (error) { throw stockFailure(error, "get_stock"); }
      },
      async getStockMovements(input) {
        requireSync();
        try {
          const identity = syncIdentity();
          return (await client.getStockMovements(input)).map((row, itemIndex) => {
            const skuRef = reference(row.sku);
            if (!skuRef) return { kind: "rejected" as const, itemIndex, reason: "invalid_sku_ref" as const };
            return { ...identity, skuRef, quantityKind: "movement" as const, quantity: row.quantity, occurredAt: timestamp(row.occurredAt),
              operationType: reference(row.operationType), documentRef: reference(row.warehouseDocumentNumber), lotRef: reference(row.lotNumber), expirationDate: /^\d{4}-\d\d-\d\d$/u.test(row.expirationDate ?? "") ? row.expirationDate : null };
          });
        } catch (error) { throw stockFailure(error, "get_stock_movements"); }
      },
    },
    productSync: {
      async ensureProduct(sku) {
        requireSync();
        try {
          const metadata = await config.product?.resolvePushMetadata(sku);
          if (!metadata) return null;
          await client.createProduct(metadata, sku);
          return { replayed: false };
        } catch (error) { throw syncFailure("createProduct", error); }
      },
      async getProductPacks(sku) {
        requireSync();
        requireProductSku(sku);
        try { return (await client.getProduct(sku)).packs.map(pack => ({ ean: pack.ean, quantity: pack.quantity })); }
        catch (error) { throw syncFailure("getProduct", error); }
      },
      async addProductPack(sku, pack) {
        requireSync();
        if (!/^\d{8,14}$/u.test(pack.ean) || !Number.isSafeInteger(pack.quantity) || pack.quantity <= 0) throw new OmnipackSyncError("malformed", "sync");
        try { await client.createProductPack(sku, { ean: pack.ean, quantity: pack.quantity }, pack.ean); }
        catch (error) { throw syncFailure("createProductPack", error); }
      },
      async listStockedSkus() {
        requireSync();
        try { return [...new Set((await client.getStock()).flatMap(row => row.sku.trim() ? [row.sku] : []))]; }
        catch (error) { throw syncFailure("getStock", error); }
      },
    },
  };
}

// buildOmnipackDispatchPayloadFromCandidate forwards only name/email/phone and
// line1/city/postalCode/country to buildOmnipackOutboundOrderPayload; neither
// codec reads line titles, recipient line2/deliveryInstructions/courierInstructions,
// or pickup-point provider/name/address (readPickUpPoint reads only its id).
// Exclude those descriptions; retain host request/order/fulfillment/parcel and
// product/pack identities as well as all wire/evidence-bearing request values.
// The submission retains only this SHA-256 hash in memory, never the raw values.
function commandDigest(request: FulfillmentDispatchRequest): string {
  return stableDispatchHash({
    requestKey: request.requestKey, fulfillmentRef: request.fulfillmentRef,
    orderRef: request.orderRef, orderNumber: request.orderNumber, parcelRef: request.parcelRef,
    contactRevision: { schemaVersion: request.contactRevision.schemaVersion,
      source: request.contactRevision.source, revision: request.contactRevision.revision },
    recipient: { name: request.recipient.name, email: request.recipient.email, phone: request.recipient.phone,
      line1: request.recipient.line1, city: request.recipient.city, postalCode: request.recipient.postalCode, country: request.recipient.country },
    lines: request.lines.map(line => ({ skuRef: line.skuRef, productRef: line.productRef, packRef: line.packRef, quantity: line.quantity })),
    selection: { providerRef: request.selection.providerRef, carrierRef: request.selection.carrierRef,
      serviceRef: request.selection.serviceRef, deliveryKind: request.selection.deliveryKind,
      pickupPointId: request.selection.pickupPoint?.id ?? null },
  });
}

/** Translate only the contributed client's typed error; never copy a message or payload. */
function stockFailure(error: unknown, operation: "get_stock" | "get_stock_movements") {
  const failure = syncFailure(operation === "get_stock" ? "getStock" : "getStockMovements", error);
  if (!(error instanceof OmnipackProviderError)) return failure;
  const retryable = error.code !== "redirect_refused" && (error.retryable || error.code === "network_error");
  return Object.assign(failure, { retryable, providerError: {
    operation, status: error.status, code: error.code, retryable,
  } });
}
