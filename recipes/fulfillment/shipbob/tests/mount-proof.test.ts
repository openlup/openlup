import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createFulfillmentProviderRegistry,
  createFulfillmentServices,
  fulfillmentIngressHttpResult,
  readFulfillmentCapabilities,
  runFulfillmentReconciliationPage,
  runFulfillmentStockSyncWorker,
  verifyAndNormalizeFulfillmentObservation,
} from "@openlup/platform/fulfillment";
import type {
  DispatchRecord,
  FulfillmentDispatchRequest,
  FulfillmentObservation,
  FulfillmentStockSyncPort,
  FulfillmentStorePort,
  StockSnapshot,
  SyncCursor,
} from "@openlup/platform/fulfillment/contracts";
import {
  SHIPBOB_PROVIDER_REF,
  createShipBobFulfillmentAdapter,
  createShipBobHttpClient,
  shipbobFulfillmentCapabilities,
  type FetchLike,
} from "../server/index.js";
import {
  FIXTURE_CHANNEL_ID,
  FIXTURE_EARLIER_ISO,
  FIXTURE_NOW_ISO,
  FIXTURE_SENSITIVE_CANARIES,
  FIXTURE_WEBHOOK_SECRET_PRIMARY,
  FIXTURE_WEBHOOK_SECRET_ROTATED,
  approveFixtureTrackingUrl,
  buildDispatchRequest,
  buildShipBobInventoryPayload,
  buildShipBobOrderPayload,
  buildSignedShipBobWebhookInput,
} from "./fixtures.js";

function createInMemoryFulfillmentStore(candidate: FulfillmentDispatchRequest): {
  readonly store: FulfillmentStorePort;
  readonly records: Map<string, DispatchRecord>;
  readonly attempts: unknown[];
} {
  const records = new Map<string, DispatchRecord>();
  const byDispatchRef = new Map<string, DispatchRecord>();
  const seenAttemptKeys = new Set<string>();
  const attempts: unknown[] = [];

  const store: FulfillmentStorePort = {
    async read(requestKey) {
      return records.get(requestKey) ?? null;
    },
    async readCandidate(fulfillmentRef) {
      return fulfillmentRef === candidate.fulfillmentRef ? candidate : null;
    },
    async prepare(fulfillmentRef) {
      if (fulfillmentRef !== candidate.fulfillmentRef) {
        return { disposition: "withheld", contactRevision: null };
      }
      return {
        disposition: "ready",
        contactRevision: candidate.contactRevision.revision,
      };
    },
    async claim(input) {
      const existing = records.get(input.requestKey);
      if (existing) {
        return { kind: "claimed", record: { ...existing, replayed: true } };
      }
      const dispatchRef = `dsp_${input.requestKey}`;
      const record: DispatchRecord = {
        dispatchRef,
        requestKey: input.requestKey,
        fulfillmentRef: input.fulfillmentRef,
        orderRef: input.orderRef,
        parcelRef: input.parcelRef,
        externalRef: null,
        mode: input.mode,
        status: "draft",
        evidence: input.evidence,
        replayed: false,
      };
      records.set(input.requestKey, record);
      byDispatchRef.set(dispatchRef, record);
      return { kind: "claimed", record };
    },
    async recordProviderAttempt(attemptKey, fulfillmentRef, preparedEvidence, mode, status) {
      const replayed = seenAttemptKeys.has(attemptKey);
      if (!replayed) {
        seenAttemptKeys.add(attemptKey);
        attempts.push({ attemptKey, fulfillmentRef, preparedEvidence, mode, status });
      }
      return { replayed };
    },
    async begin(input) {
      const current = byDispatchRef.get(input.dispatchRef);
      if (!current) {
        return {
          kind: "refused",
          refusal: { reason: "local_missing", phase: "begin", retryable: false },
        };
      }
      if (current.status === "created") {
        return { kind: "begun", record: current, begun: false, replayed: true };
      }
      const updated: DispatchRecord = { ...current, status: "submitting", replayed: false };
      records.set(updated.requestKey, updated);
      byDispatchRef.set(updated.dispatchRef, updated);
      return { kind: "begun", record: updated, begun: true, replayed: false };
    },
    async finalize(input) {
      const current = byDispatchRef.get(input.dispatchRef)!;
      const updated: DispatchRecord =
        input.result.kind === "accepted"
          ? {
              ...current,
              status: "uncertain",
              externalRef: input.result.externalRef,
              evidence: input.result.evidence,
              acceptance: input.result,
              replayed: false,
            }
          : input.result.kind === "not_dispatched"
            ? { ...current, status: "failed", replayed: false }
            : { ...current, status: "uncertain", replayed: false };
      records.set(updated.requestKey, updated);
      byDispatchRef.set(updated.dispatchRef, updated);
      return updated;
    },
    async acknowledge(input) {
      const current = byDispatchRef.get(input.dispatchRef)!;
      const replayed = current.status === "created";
      const updated: DispatchRecord = {
        ...current,
        status: "created",
        externalRef: input.acceptance.externalRef,
        acceptance: input.acceptance,
        replayed,
      };
      records.set(updated.requestKey, updated);
      byDispatchRef.set(updated.dispatchRef, updated);
      return { acknowledged: true, replayed, record: updated };
    },
    async markStaleSubmissionsUncertain() {
      return 0;
    },
  };

  return { store, records, attempts };
}

describe("recipes/fulfillment/shipbob — Stage 3 real-flow mount proof", () => {
  it("mounts into createFulfillmentProviderRegistry, runs dispatch worker, verified ingress, reconciliation paging, and snapshot-only stock sync", async () => {
    const calls: { readonly method: string; readonly url: string; readonly body?: string }[] = [];

    const fetchImpl: FetchLike = async (urlString, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? init.body : undefined;
      calls.push({ method, url: urlString, body });
      const url = new URL(urlString);

      if (method === "POST" && url.pathname === "/1.0/order") {
        return new Response(
          JSON.stringify({
            id: 900101,
            reference_id: "SB-ORD-MOUNT-01",
            status: "Processing",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET" && url.pathname === "/1.0/order") {
        const page = Number(url.searchParams.get("Page"));
        if (page === 1) {
          return new Response(
            JSON.stringify([
              buildShipBobOrderPayload({
                id: 900101,
                reference_id: "SB-ORD-MOUNT-01",
                order_number: "ORD-MOUNT-01",
                status: "Processing",
                last_updated_at: FIXTURE_NOW_ISO,
                created_date: FIXTURE_EARLIER_ISO,
                shipments: [
                  {
                    id: "SHP-MOUNT-01",
                    status: "InTransit",
                    last_updated_at: FIXTURE_NOW_ISO,
                    tracking: {
                      tracking_number: "1Z999AA10987654321",
                      carrier: "UPS",
                      tracking_url: "https://track.carrier.example/1Z999AA10987654321",
                    },
                  },
                ],
              }),
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.pathname === "/1.0/inventory") {
        return new Response(
          JSON.stringify(
            buildShipBobInventoryPayload([
              {
                sku: "SKU-WIDGET-01",
                total_on_hand_quantity: 50,
                total_fulfillable_quantity: 42,
                total_committed_quantity: 6,
                total_awaiting_quantity: 2,
                last_updated_date: FIXTURE_NOW_ISO,
              },
            ]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected mount-proof request: ${method} ${urlString}`);
    };

    const client = createShipBobHttpClient({
      environment: "sandbox",
      token: FIXTURE_SENSITIVE_CANARIES.patToken,
      channelId: FIXTURE_CHANNEL_ID,
      fetchImpl,
    });

    const adapter = createShipBobFulfillmentAdapter({
      client,
      webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
      clock: () => FIXTURE_NOW_ISO,
      selected: true,
      ready: true,
      approveTrackingUrl: approveFixtureTrackingUrl,
    });

    // 1. Registry mount & default-off guard
    const registry = createFulfillmentProviderRegistry([adapter]);
    expect(registry.refs()).toEqual([SHIPBOB_PROVIDER_REF]);
    const mounted = registry.requireAdapter(SHIPBOB_PROVIDER_REF);

    const defaultOffDecision = readFulfillmentCapabilities([shipbobFulfillmentCapabilities], {
      providerRef: SHIPBOB_PROVIDER_REF,
      carrierRef: null,
      serviceRef: "Standard",
      deliveryKind: "courier",
      pickupPoint: null,
    });
    expect(defaultOffDecision).toEqual({
      kind: "refused",
      refusal: { reason: "disabled", phase: "selection", retryable: false },
    });

    // 2. Real Dispatch Worker flow via createFulfillmentServices
    const dispatchCandidate = buildDispatchRequest({
      requestKey: "req_mount_01",
      fulfillmentRef: "ful_mount_01",
      orderRef: "ord_mount_01",
      orderNumber: "ORD-MOUNT-01",
      parcelRef: "SB-ORD-MOUNT-01",
    });
    const { store, records, attempts } = createInMemoryFulfillmentStore(dispatchCandidate);

    const services = createFulfillmentServices({
      enabled: true,
      selection: dispatchCandidate.selection,
      capability: mounted.capabilities,
      store,
      provider: mounted.dispatch,
      readiness: async () => ({ ready: true }),
      listCandidates: async () => [dispatchCandidate],
      keys: {
        request: (req) => req.requestKey,
        mappedAttempt: (requestKey, idx) => `attempt:${requestKey}:${idx}`,
        acceptance: (fulfillmentRef) => ({
          providerAttemptKey: `acc_attempt:${fulfillmentRef}`,
          labelKey: `acc_label:${fulfillmentRef}`,
        }),
      },
      config: { mode: "live", batchLimit: 10 },
      now: () => new Date(FIXTURE_NOW_ISO),
    });

    const dispatchRun1 = await services.runDispatch();
    expect("ok" in dispatchRun1 && dispatchRun1.ok).toBe(true);
    const createdRecord = records.get("req_mount_01");
    expect(createdRecord?.externalRef).toBe("900101");
    expect(createdRecord?.status).toBe("created");

    const postCall = calls.find((c) => c.method === "POST" && c.url.includes("/1.0/order"));
    expect(postCall?.body).toBeDefined();
    const sentWirePayload = JSON.parse(postCall!.body!) as Record<string, unknown>;
    expect(sentWirePayload["reference_id"]).toBe("SB-ORD-MOUNT-01");
    expect(sentWirePayload["order_number"]).toBe("ORD-MOUNT-01");
    expect(sentWirePayload["shipping_method"]).toBe("Standard");
    const expectedWireFingerprint = createHash("sha256")
      .update(JSON.stringify(sentWirePayload), "utf8")
      .digest("hex");
    expect(createdRecord?.evidence.commandFingerprint).toBe(expectedWireFingerprint);

    const serializedStore = JSON.stringify({
      records: [...records.values()],
      attempts,
    });
    for (const canary of Object.values(FIXTURE_SENSITIVE_CANARIES)) {
      expect(serializedStore).not.toContain(canary);
    }

    const postsAfterRun1 = calls.filter(
      (c) => c.method === "POST" && c.url.includes("/1.0/order"),
    ).length;
    expect(postsAfterRun1).toBe(1);
    await services.runDispatch();
    const postsAfterRun2 = calls.filter(
      (c) => c.method === "POST" && c.url.includes("/1.0/order"),
    ).length;
    expect(postsAfterRun2).toBe(1);

    // 3. Real Verified Ingress flow
    const seenObservations = new Map<string, FulfillmentObservation>();
    const sideEffects: string[] = [];

    const runIngress = (
      verification: Parameters<NonNullable<typeof mounted.observation>["verifyAndNormalize"]>[0],
    ) =>
      verifyAndNormalizeFulfillmentObservation({
        enabled: true,
        approveTrackingUrl: approveFixtureTrackingUrl,
        provider: mounted.observation!,
        verification,
        localPersistence: {
          async recordObservation(obs) {
            const existing = seenObservations.get(obs.eventKey);
            if (existing) {
              return { replayed: true, receiptId: obs.eventKey, observation: existing };
            }
            seenObservations.set(obs.eventKey, obs);
            return { replayed: false, receiptId: obs.eventKey, observation: obs };
          },
          async markProcessed() {
            // Recorded processed receipt.
          },
        },
        lifecycle: {
          async findDispatchRef(obs) {
            if (obs.correlation.externalRef === "900101") {
              return {
                orderRef: "ord_mount_01",
                fulfillmentRef: "ful_mount_01",
                dispatchRef: "req_mount_01",
                externalRef: "900101",
              };
            }
            return null;
          },
          async acknowledgeDispatchAcceptance() {
            sideEffects.push("ack");
          },
          async recordStatusEvidence(_ref, obs) {
            const key = `status:${obs.eventKey}`;
            const replayed = sideEffects.includes(key);
            if (!replayed) sideEffects.push(key);
            return { replayed };
          },
          effects: {
            async markProviderStockConsumed({ idempotencyKey }) {
              const replayed = sideEffects.includes(idempotencyKey);
              if (!replayed) sideEffects.push(idempotencyKey);
              return { replayed };
            },
            async markHandedOver({ idempotencyKey }) {
              const replayed = sideEffects.includes(idempotencyKey);
              if (!replayed) sideEffects.push(idempotencyKey);
              return { replayed };
            },
            async recordTrackingReference({ idempotencyKey }) {
              const replayed = sideEffects.includes(idempotencyKey);
              if (!replayed) sideEffects.push(idempotencyKey);
              return { replayed, readBack: true };
            },
          },
          keys: {
            stock: (ref) => `stock:${ref}`,
            handoff: (ref) => `handoff:${ref}`,
            tracking: (eventKey, number) => `tracking:${eventKey}:${number}`,
          },
          classifyFailure: () => "other",
        },
      });

    const deliveredWebhook = buildSignedShipBobWebhookInput({
      webhookId: "msg_mount_delivered",
      topic: "order_shipment_delivered",
      orderId: 900101,
      referenceId: "SB-ORD-MOUNT-01",
      orderNumber: "ORD-MOUNT-01",
      status: "Completed",
      shipmentStatus: "Delivered",
      shipmentId: "SHP-MOUNT-01",
      lastUpdatedAt: FIXTURE_NOW_ISO,
      tracking: {
        tracking_number: "1Z999AA10987654321",
        carrier: "UPS",
        tracking_url: "https://track.carrier.example/1Z999AA10987654321",
      },
    });

    const ingress1 = await runIngress(deliveredWebhook);
    expect(ingress1.kind).toBe("processed");
    expect(fulfillmentIngressHttpResult(ingress1)).toEqual({ status: 200, messageClass: "accepted" });
    expect(sideEffects).toContain("stock:ful_mount_01");
    expect(sideEffects).toContain("handoff:ful_mount_01");

    const ingressReplay = await runIngress(deliveredWebhook);
    expect(ingressReplay.kind).toBe("processed");
    if (ingressReplay.kind === "processed") {
      expect(ingressReplay.replayed).toBe(true);
    }

    const tamperedWebhook = buildSignedShipBobWebhookInput({
      webhookId: "msg_mount_tampered",
      topic: "order_shipment_delivered",
      orderId: 900101,
      status: "Completed",
      lastUpdatedAt: FIXTURE_NOW_ISO,
      tamperSignature: true,
    });
    const ingressTampered = await runIngress(tamperedWebhook);
    expect(ingressTampered.kind).toBe("refused");
    expect(fulfillmentIngressHttpResult(ingressTampered)).toEqual({
      status: 403,
      messageClass: "forbidden",
    });

    // 4. Real Paged Reconciliation flow via runFulfillmentReconciliationPage
    const reconPage1 = await runFulfillmentReconciliationPage({
      provider: mounted.reconciliation!,
      pageSize: 1,
      checkpoint: null,
      localPersistence: {
        readLocalFulfillmentStatus: async () => "provider_received",
        latestStatusOccurredAt: async () => FIXTURE_EARLIER_ISO,
        readHandedOverAt: async () => null,
      },
      lifecycle: {
        findDispatchRef: async (evidence) =>
          evidence.correlation.externalRef === "900101"
            ? {
                orderRef: "ord_mount_01",
                fulfillmentRef: "ful_mount_01",
                dispatchRef: "req_mount_01",
                externalRef: "900101",
              }
            : null,
        acknowledgeDispatchAcceptance: async () => {},
        recordStatusEvidence: async () => ({ replayed: false }),
        recordQuarantine: async () => ({ replayed: false }),
        recordProviderException: async () => ({ replayed: false }),
        readDeliveryCarrier: async () => ({ carrierRef: "ups", serviceRef: "Standard" }),
        trackingCodecs: {
          approveTrackingUrl: approveFixtureTrackingUrl,
          normalizeCarrier: ({ carrierRef }) => carrierRef,
          publicUrl: (_carrier, num) => `https://track.carrier.example/${num}`,
        },
        effects: {
          markProviderStockConsumed: async () => ({ replayed: false }),
          markHandedOver: async () => ({ replayed: false }),
          recordTrackingReference: async () => ({ replayed: false, readBack: true }),
        },
        keys: {
          stock: (ref) => `recon:stock:${ref}`,
          handoff: (ref) => `recon:handoff:${ref}`,
          tracking: (eventKey, number) => `recon:tracking:${eventKey}:${number}`,
        },
        invoiceFailure: () => ({ permanent: false, identifier: null, sqlstate: null, benign: false }),
        classifyStateConflict: () => null,
      },
    });
    expect(reconPage1.status).toBe(200);
    expect(reconPage1.ledgerStatus).toBe("succeeded");
    expect(reconPage1.result.updated).toBe(1);
    expect(reconPage1.metadata.reconciliationPagination.nextPage).toBe(1);

    const reconPage2 = await runFulfillmentReconciliationPage({
      provider: mounted.reconciliation!,
      pageSize: 1,
      checkpoint: reconPage1.metadata,
      localPersistence: {
        readLocalFulfillmentStatus: async () => "in_transit",
        latestStatusOccurredAt: async () => FIXTURE_NOW_ISO,
        readHandedOverAt: async () => FIXTURE_NOW_ISO,
      },
      lifecycle: {
        findDispatchRef: async () => null,
        acknowledgeDispatchAcceptance: async () => {},
        recordStatusEvidence: async () => ({ replayed: false }),
        recordQuarantine: async () => ({ replayed: false }),
        recordProviderException: async () => ({ replayed: false }),
        readDeliveryCarrier: async () => null,
        trackingCodecs: {
          approveTrackingUrl: approveFixtureTrackingUrl,
          normalizeCarrier: ({ carrierRef }) => carrierRef,
          publicUrl: () => null,
        },
        effects: {
          markProviderStockConsumed: async () => ({ replayed: false }),
          markHandedOver: async () => ({ replayed: false }),
          recordTrackingReference: async () => ({ replayed: false, readBack: true }),
        },
        keys: {
          stock: (ref) => `recon:stock:${ref}`,
          handoff: (ref) => `recon:handoff:${ref}`,
          tracking: (eventKey, number) => `recon:tracking:${eventKey}:${number}`,
        },
        invoiceFailure: () => ({ permanent: false, identifier: null, sqlstate: null, benign: false }),
        classifyStateConflict: () => null,
      },
    });
    expect(reconPage2.status).toBe(200);
    expect(reconPage2.result.checked).toBe(0);

    // 5. Real Snapshot-Only Stock Sync flow via runFulfillmentStockSyncWorker
    const recordedSnapshots: StockSnapshot[] = [];
    let latestCursor: SyncCursor | null = null;
    const stockPort: FulfillmentStockSyncPort = {
      readCursor: async () => latestCursor,
      readLocalInventoryStock: async () => [
        {
          skuRef: "SKU-WIDGET-01",
          quantity: { onHand: 42, reserved: 2, unavailable: 0, safetyStock: 5 },
          fulfillable: true,
          locationStatus: "active",
          lotStatus: "available",
          expiresAt: null,
        },
      ],
      readSkuInventoryClasses: async () => new Map([["SKU-WIDGET-01", "sellable"]]),
      readActiveReservations: async () => new Map([["SKU-WIDGET-01", 2]]),
      recordCursor: async (cursor) => {
        latestCursor = cursor;
      },
      recordStockSnapshot: async ({ snapshot }) => {
        recordedSnapshots.push(snapshot);
        return { replayed: false, readBack: true };
      },
      recordProviderStockCurrent: async () => ({ replayed: false, readBack: true }),
      recordMovement: async () => ({ replayed: false, readBack: true }),
      recordLowStockEvidence: async () => ({ replayed: false }),
      resolveLowStockEvidence: async () => ({ resolved: 0 }),
    };

    const stockRun = await runFulfillmentStockSyncWorker({
      port: stockPort,
      provider: mounted.stockSync!,
      movementBatchSize: 10,
      stockMovements: false,
      now: () => new Date(FIXTURE_NOW_ISO),
      compatibility: {
        syncRunId: () => "mount_sync_001",
        staleEvidenceSku: "__stale__",
        timeZone: "UTC",
        currentKey: (run, sku) => `cur:${run}:${sku}`,
        snapshotKey: (run, sku) => `snap:${run}:${sku}`,
        lowStockKey: (sku, t) => `low:${sku}:${t}`,
        staleKey: (ts) => `stale:${ts}`,
      },
    });
    expect(stockRun.ok).toBe(true);
    expect(stockRun.checked).toBe(1);
    expect(stockRun.movementRefusal).toEqual({
      reason: "stock_movements_unsupported",
      phase: "sync",
      retryable: false,
    });
    expect(recordedSnapshots).toHaveLength(1);
    expect(recordedSnapshots[0]?.forSaleQuantity).toBe(42);
  });

  it("enforces negative controls: detached registry, wrong whsec_ key, and unready adapter", async () => {
    // NC1: Detached registry refuses unknown provider
    const emptyRegistry = createFulfillmentProviderRegistry([]);
    expect(() => emptyRegistry.requireAdapter(SHIPBOB_PROVIDER_REF)).toThrow(
      `unknown_fulfillment_provider_ref:${SHIPBOB_PROVIDER_REF}`,
    );

    // NC2: Wrong whsec_ signing key refuses valid notification with HTTP 403 and zero persistence writes
    let networkCalls = 0;
    const silentClient = createShipBobHttpClient({
      environment: "sandbox",
      token: FIXTURE_SENSITIVE_CANARIES.patToken,
      fetchImpl: async () => {
        networkCalls += 1;
        throw new Error("should_not_call_network");
      },
    });
    const wrongKeyAdapter = createShipBobFulfillmentAdapter({
      client: silentClient,
      webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_ROTATED],
      clock: () => FIXTURE_NOW_ISO,
      selected: true,
      ready: true,
    });
    let persistenceWrites = 0;
    const validForPrimaryKey = buildSignedShipBobWebhookInput({
      webhookId: "msg_nc2",
      topic: "order_shipment_delivered",
      orderId: 900202,
      status: "Completed",
      lastUpdatedAt: FIXTURE_NOW_ISO,
      secretWhsec: FIXTURE_WEBHOOK_SECRET_PRIMARY,
    });
    const nc2Result = await verifyAndNormalizeFulfillmentObservation({
      enabled: true,
      provider: wrongKeyAdapter.observation!,
      verification: validForPrimaryKey,
      localPersistence: {
        recordObservation: async (obs) => {
          persistenceWrites += 1;
          return { replayed: false, receiptId: obs.eventKey, observation: obs };
        },
        markProcessed: async () => {
          persistenceWrites += 1;
        },
      },
      lifecycle: {
        findDispatchRef: async () => null,
        acknowledgeDispatchAcceptance: async () => {},
        recordStatusEvidence: async () => ({ replayed: false }),
        effects: {
          markProviderStockConsumed: async () => ({ replayed: false }),
          markHandedOver: async () => ({ replayed: false }),
          recordTrackingReference: async () => ({ replayed: false, readBack: true }),
        },
        keys: {
          stock: (ref) => ref,
          handoff: (ref) => ref,
          tracking: (e, n) => `${e}:${n}`,
        },
        classifyFailure: () => "other",
      },
    });
    expect(nc2Result.kind).toBe("refused");
    expect(fulfillmentIngressHttpResult(nc2Result)).toEqual({
      status: 403,
      messageClass: "forbidden",
    });
    expect(persistenceWrites).toBe(0);

    // NC3: Unready adapter refuses dispatch with not_ready and zero HTTP calls
    const unreadyAdapter = createShipBobFulfillmentAdapter({
      client: silentClient,
      webhookSigningSecrets: [FIXTURE_WEBHOOK_SECRET_PRIMARY],
      clock: () => FIXTURE_NOW_ISO,
      selected: true,
      ready: false,
    });
    const req = buildDispatchRequest();
    const { store } = createInMemoryFulfillmentStore(req);
    const services = createFulfillmentServices({
      enabled: true,
      selection: req.selection,
      capability: unreadyAdapter.capabilities,
      store,
      provider: unreadyAdapter.dispatch,
      readiness: async () => ({ ready: true }),
      listCandidates: async () => [req],
      keys: {
        request: (r) => r.requestKey,
        mappedAttempt: (requestKey, idx) => `${requestKey}:${idx}`,
        acceptance: (fulfillmentRef) => ({
          providerAttemptKey: `acc_attempt:${fulfillmentRef}`,
          labelKey: `acc_label:${fulfillmentRef}`,
        }),
      },
      config: { mode: "live", batchLimit: 5 },
    });
    const nc3Result = await services.runDispatch();
    expect(nc3Result).toEqual({
      kind: "refused",
      refusal: { reason: "not_ready", phase: "selection", retryable: false },
    });
    expect(networkCalls).toBe(0);
  });
});
