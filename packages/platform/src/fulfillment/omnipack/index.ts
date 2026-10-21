import type { DispatchEvidence, FulfillmentCapabilityDescriptor, FulfillmentDispatchPort, FulfillmentDispatchRequest,
  FulfillmentLabelPort, FulfillmentObservationPort, FulfillmentReadbackPort, FulfillmentStockSyncProvider, FulfillmentProductSyncProvider } from "../contracts/index.js";
import { createOmnipackClient, OmnipackProviderError } from "./client.js";
import { omnipackFulfillmentCapabilities } from "./capabilities.js";
import { buildOmnipackDispatchCommand, serializeOmnipackDispatchPayload, stableDispatchHash } from "./omnipackDispatchPayload.js";
import { mapOmnipackWebhookPayload } from "./mappers.js";
import { verifyOmnipackWebhookToken, type OmnipackWebhookRouteEvent } from "./omnipackWebhookPayload.js";
import { localStatusFor, normalizeStatus } from "./omnipackStatusVocabulary.js";
import { digest, eventKind, observation, reference, refusal, timestamp } from "./observation.js";
export { omnipackFulfillmentCapabilities } from "./capabilities.js";

/** Node-only, explicit construction. Secrets are supplied per call, never retained as values. */
export interface OmnipackFulfillmentAdapterConfig {
  http: {
    baseUrl: string; credentials: () => { username: string; password: string } | Promise<{ username: string; password: string }>;
    fetchImpl: typeof fetch; timeoutMs: number; safeReadRetries: number; productPath: string;
  };
  selected?: boolean;
  /** Per-instance entry cap for submissions and each preparation map; default 10,000. No eviction. */
  maxRetainedSubmissions?: number;
  /** Host account evidence, independent of credentials. Omission remains not ready. */
  readiness?: FulfillmentCapabilityDescriptor["readiness"];
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
  const prepared = new Map<string, { body: string; evidence: DispatchEvidence; requestDigest: string; generation: number }>();
  const preparations = new Map<string, number>();
  const submissions = new Map<string, { evidenceKey: string; commandDigest: string; result: ReturnType<FulfillmentDispatchPort["dispatch"]> }>();
  const selectionFailure = (request: FulfillmentDispatchRequest) => {
    if (!request.selection?.providerRef?.trim()) return refusal("selection_required", "selection");
    if (request.selection.providerRef !== capabilities.providerRef) return refusal("provider_mismatch", "selection");
    if (!reference(request.selection.carrierRef) || !reference(request.selection.serviceRef)) return refusal("carrier_service_required", "selection");
    if (!capabilities.selected) return refusal("disabled", "selection");
    if (!capabilities.readiness.ready) return refusal("not_ready", "selection");
    return null;
  };
  const requireSync = () => {
    if (!capabilities.selected || !capabilities.readiness.ready) throw refusal(capabilities.selected ? "not_ready" : "disabled", "sync");
  };
  const syncIdentity = () => {
    const syncRunId = reference(config.mintSyncRunId());
    const collectedAt = timestamp(config.clock());
    if (!syncRunId || !collectedAt) throw refusal("malformed", "sync");
    return { providerRef: capabilities.providerRef, syncRunId, collectedAt, sourceRevision: null, revisionSource: "collection" as const };
  };
  return {
    capabilities,
    dispatch: {
      async prepare(request) {
        try {
          const requestDigest = stableDispatchHash(request);
          if (!preparations.has(requestDigest) && preparations.size >= maxRetainedSubmissions)
            return { kind: "refused", refusal: refusal("not_dispatchable", "prepare") };
          const generation = (preparations.get(requestDigest) ?? 0) + 1;
          preparations.set(requestDigest, generation);
          const failed = selectionFailure(request);
          if (failed) return { kind: "refused", refusal: failed };
          if (!Number.isSafeInteger(request.contactRevision.schemaVersion) || request.contactRevision.schemaVersion < 1
            || !reference(request.contactRevision.source) || !Number.isSafeInteger(request.contactRevision.revision)
            || request.contactRevision.revision < 0) return { kind: "refused", refusal: refusal("not_dispatchable", "prepare") };
          const lines = [];
          for (const line of request.lines) {
            const metadata = await config.resolveProduct(line);
            if (!metadata) return { kind: "refused", refusal: refusal("not_dispatchable", "prepare") };
            lines.push({ sku: line.skuRef, quantity: line.quantity, productSnapshot: { lotNumber: metadata.lotNumber, expirationDate: metadata.expirationDate } });
          }
          if (stableDispatchHash(request) !== requestDigest) return { kind: "refused", refusal: refusal("not_dispatchable", "prepare") };
          const command = buildOmnipackDispatchCommand({
            orderId: request.orderRef, orderNumber: request.orderNumber,
            deliveryContact: { revision: request.contactRevision.revision, recipientName: request.recipient.name,
              contactEmail: request.recipient.email, contactPhone: request.recipient.phone, line1: request.recipient.line1,
              city: request.recipient.city, postalCode: request.recipient.postalCode, country: request.recipient.country,
              selectedDelivery: { providerKind: capabilities.providerRef, carrierKind: request.selection.carrierRef,
                serviceCode: request.selection.serviceRef, deliveryKind: request.selection.deliveryKind, pickupPoint: request.selection.pickupPoint } }, lines,
          });
          const evidence: DispatchEvidence = { commandFingerprint: command.requestFingerprint,
            contactRevision: { schemaVersion: request.contactRevision.schemaVersion, source: request.contactRevision.source, revision: request.contactRevision.revision },
            providerRef: capabilities.providerRef, carrierRef: request.selection.carrierRef, serviceRef: request.selection.serviceRef };
          if (preparations.get(requestDigest) !== generation) return { kind: "refused", refusal: refusal("not_dispatchable", "prepare") };
          const evidenceKey = serializeOmnipackDispatchPayload(evidence).body;
          if (!prepared.has(evidenceKey) && prepared.size >= maxRetainedSubmissions)
            return { kind: "refused", refusal: refusal("not_dispatchable", "prepare") };
          prepared.set(evidenceKey, { body: command.body, evidence: structuredClone(evidence), requestDigest, generation });
          return { kind: "prepared", evidence };
        } catch { return { kind: "refused", refusal: refusal("not_dispatchable", "prepare") }; }
      },
      async dispatch(request, evidence) {
        let command;
        let evidenceKey: string;
        let requestCommandDigest: string;
        try {
          // Validate the closed evidence and its request-bound values without consulting preparation state.
          if (Object.keys(evidence).length !== 5 || Object.keys(evidence.contactRevision).length !== 3
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
          requestCommandDigest = commandDigest(request);
          const submitted = submissions.get(evidence.commandFingerprint);
          if (submitted) {
            // Replay is bound to this submission's evidence and command, never replaceable preparation.
            if (submitted.evidenceKey !== evidenceKey || submitted.commandDigest !== requestCommandDigest) throw Error();
            return structuredClone(await submitted.result);
          }
          command = prepared.get(evidenceKey);
          const requestDigest = stableDispatchHash(request);
          if (selectionFailure(request) || !command || command.requestDigest !== requestDigest || preparations.get(requestDigest) !== command.generation) throw Error();
          if (submissions.size >= maxRetainedSubmissions) throw Error();
        } catch { return { kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: refusal("not_dispatchable", "dispatch") }; }
        const fingerprint = command.evidence.commandFingerprint;
        // Defer submission until its promise is recorded, before any credential or HTTP callback.
        const result = Promise.resolve().then(async () => {
          try {
            const result = await client.createOrder(command.body);
            const externalRef = reference(result.providerOrderId);
            if (!externalRef) return { kind: "unknown" as const, effectMayHaveSucceeded: true as const, refusal: refusal("malformed", "acknowledge") };
            // Opaque provider proof; the worker replaces these with authoritative host keys.
            const proof = digest(JSON.stringify([externalRef, command.evidence.commandFingerprint]));
            return { kind: "accepted" as const, externalRef, evidence: structuredClone(command.evidence),
              providerAttemptKey: `attempt:${proof}`, labelKey: `label:${proof}` };
          } catch (error) {
            return error instanceof OmnipackProviderError && !error.mayHaveSucceeded
              ? { kind: "not_dispatched" as const, effectMayHaveSucceeded: false as const, refusal: refusal("io_failure", "dispatch") }
              : { kind: "unknown" as const, effectMayHaveSucceeded: true as const, refusal: refusal("io_failure", "dispatch") };
          } finally { command.body = ""; }
        });
        submissions.set(fingerprint, { evidenceKey, commandDigest: requestCommandDigest, result });
        // Submission owns replay from here, so releasing these transient bytes cannot reopen a POST.
        prepared.delete(evidenceKey);
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
          const row = matches[0]!;
          const normalized = normalizeStatus(row.status);
          if (!normalized) return { kind: "unknown", refusal: refusal("unsupported_event", "readback") };
          const status = localStatusFor(normalized) as "provider_received" | "picking" | "packed" | "in_transit" | "delivered" | "exception";
          const event = ({ provider_received: "shipment.accepted", picking: "order.processing_started", packed: "order.picked", in_transit: "order.shipped", delivered: "order.delivered", exception: "parcel.exception" } as const)[status];
          const evidence = { provider: "omnipack" as const, event, providerOrderId: row.providerOrderId, orderNumber: row.orderNumber,
            fulfilmentNumber: row.fulfilmentNumber, occurredAt: row.updatedAt, trackingNumbers: row.trackingNumbers,
            trackingReferences: row.trackingReferences, shippingMethods: [] };
          return { kind: "found", externalRef: input.externalRef!, createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt),
            observation: observation({ evidence, event, status, fulfillmentRef: input.fulfillmentRef, receivedAt: config.clock(),
              rawDigest: digest(JSON.stringify(evidence)), evidenceRef: config.mintEvidenceReference(), source: "provider_reconciliation", approveTrackingUrl: config.approveTrackingUrl }) };
        } catch { return { kind: "unknown", refusal: refusal("io_failure", "readback") }; }
      },
    },
    stockSync: {
      async getStock() {
        requireSync();
        try {
          const identity = syncIdentity();
          return (await client.getStock()).map(row => {
            const skuRef = reference(row.sku);
            if (!skuRef) throw refusal("malformed", "sync");
            return { ...identity, skuRef, quantityKind: "snapshot" as const, totalQuantity: row.totalQuantity,
              forSaleQuantity: row.forSaleQuantity, reservedOrUnavailableQuantity: row.reservedOrUnavailableQuantity };
          });
        } catch { throw refusal("io_failure", "sync"); }
      },
      async getStockMovements(input) {
        requireSync();
        try {
          const identity = syncIdentity();
          return (await client.getStockMovements(input)).map(row => {
            const skuRef = reference(row.sku);
            if (!skuRef) throw refusal("malformed", "sync");
            return { ...identity, skuRef, quantityKind: "movement" as const, quantity: row.quantity, occurredAt: timestamp(row.occurredAt),
              operationType: reference(row.operationType), documentRef: reference(row.warehouseDocumentNumber), lotRef: reference(row.lotNumber), expirationDate: /^\d{4}-\d\d-\d\d$/u.test(row.expirationDate ?? "") ? row.expirationDate : null };
          });
        } catch { throw refusal("io_failure", "sync"); }
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
        } catch { throw refusal("io_failure", "sync"); }
      },
      async getProductPacks(sku) {
        requireSync();
        try { return (await client.getProduct(sku)).packs.filter(pack => /^\d{8,14}$/u.test(pack.ean) && Number.isSafeInteger(pack.quantity) && pack.quantity > 0).map(pack => ({ ean: pack.ean, quantity: pack.quantity })); }
        catch { throw refusal("io_failure", "sync"); }
      },
      async addProductPack(sku, pack) {
        requireSync();
        if (!/^\d{8,14}$/u.test(pack.ean) || !Number.isSafeInteger(pack.quantity) || pack.quantity <= 0) throw refusal("malformed", "sync");
        try { await client.createProductPack(sku, { ean: pack.ean, quantity: pack.quantity }, pack.ean); }
        catch { throw refusal("io_failure", "sync"); }
      },
      async listStockedSkus() {
        requireSync();
        try { return [...new Set((await client.getStock()).flatMap(row => reference(row.sku) ? [row.sku] : []))]; }
        catch { throw refusal("io_failure", "sync"); }
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
