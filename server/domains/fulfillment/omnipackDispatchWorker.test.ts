import { describe, expect, it, vi } from "vitest";
import {
  buildSanitizedEvidence,
  dispatchIdempotencyKey,
  OMNIPACK_DISPATCH_CONTACT_STALE,
  readOmnipackDispatchMode,
  runOmnipackDispatchWorker,
  type OmnipackDispatchCandidate,
  type OmnipackDispatchPort,
  type OmnipackDispatchReadBack,
  type OmnipackDispatchRefStatus,
} from "./omnipackDispatchWorker.js";

describe("OmniPack dispatch worker", () => {
  it("defaults to shadow mode unless explicitly configured", () => {
    expect(readOmnipackDispatchMode({})).toBe("shadow");
    expect(readOmnipackDispatchMode({ COMMERCE_OMNIPACK_DISPATCH_MODE: "stage" })).toBe("stage");
    expect(readOmnipackDispatchMode({ COMMERCE_OMNIPACK_DISPATCH_MODE: "live" })).toBe("live");
    expect(readOmnipackDispatchMode({ COMMERCE_OMNIPACK_DISPATCH_MODE: "production" })).toBe("shadow");
  });

  it("sweeps stale submissions before reading candidates", async () => {
    const events: string[] = [];
    const port = fakePort([candidate()], { events });

    await runOmnipackDispatchWorker({
      port,
      providerClient: fakeProviderClient(undefined, events),
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(events.slice(0, 2)).toEqual(["markStaleSubmissionsUncertain", "listCandidates"]);
    expect(port.calls.markStaleSubmissionsUncertain).toHaveLength(1);
    expect(Number.isNaN(Date.parse(port.calls.markStaleSubmissionsUncertain[0] ?? ""))).toBe(false);
  });

  it("fails closed with zero provider POSTs when the stale-submission sweep fails", async () => {
    const port = fakePort([candidate()], { failStaleSweep: true });
    const providerClient = fakeProviderClient();

    const result = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(result).toMatchObject({
      ok: false,
      checked: 0,
      failures: 1,
      providerCalls: 0,
      reason: "omnipack_dispatch_stale_submission_sweep_failed:stale_sweep_down",
    });
    expect(port.calls.listCandidates).toBe(0);
    expect(providerClient.createOrder).not.toHaveBeenCalled();
  });

  it("persists submitting before createOrder and atomically acknowledges success with stable keys", async () => {
    const events: string[] = [];
    const port = fakePort([candidate()], { events });
    const providerClient = fakeProviderClient(undefined, events);

    const result = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(result).toMatchObject({ ok: true, checked: 1, updated: 1, providerCalls: 1 });
    expect(events.indexOf("beginSubmission")).toBeLessThan(events.indexOf("createOrder"));
    expect(port.calls.beginSubmission).toEqual([{
      dispatchRefId: "dispatch-ref-1",
      requestFingerprint: expect.any(String),
    }]);
    expect(port.calls.acknowledgeDispatchAcceptance[0]).toMatchObject({
      dispatchRefId: "dispatch-ref-1",
      providerOrderId: "provider-order-1",
      providerAttemptIdempotencyKey: `${dispatchIdempotencyKey(candidate().fulfillmentOrderId)}:provider-accepted`,
      labelIdempotencyKey: `${dispatchIdempotencyKey(candidate().fulfillmentOrderId)}:label-ack`,
      sanitizedResponse: { provider: "omnipack", providerOrderId: "provider-order-1" },
    });
    expect(port.calls.finalizeSubmission).toHaveLength(0);
    expect(providerClient.createOrder).toHaveBeenCalledTimes(1);
  });

  it("passes a high-quantity multi-line order to OmniPack without truncating any line or total", async () => {
    const highQuantityLines = Array.from({ length: 6 }, (_, index) => ({
      sku: `OPENLUP-RECIPE-${index + 1}`,
      title: `Recipe ${index + 1}`,
      quantity: 99,
      productSnapshot: {},
    }));
    const port = fakePort([{ ...candidate(), lines: highQuantityLines }]);
    const providerClient = fakeProviderClient();

    const result = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(result).toMatchObject({ ok: true, providerCalls: 1 });
    const providerPayload = providerClient.createOrder.mock.calls[0]?.[0] as {
      items: Array<{ sku: string; quantity: number }>;
    };
    expect(providerPayload.items).toEqual(highQuantityLines.map(({ sku, quantity }) => ({ sku, quantity })));
    expect(providerPayload.items.reduce((sum, line) => sum + line.quantity, 0)).toBe(594);
    expect(port.calls.recordDispatchRef[0]?.sanitizedRequest).toMatchObject({
      itemCount: 6,
      items: highQuantityLines.map(({ sku, quantity }) => expect.objectContaining({ sku, quantity })),
    });
  });

  it("does not POST when persisting submitting fails", async () => {
    const port = fakePort([candidate()], { failBeginSubmission: true });
    const providerClient = fakeProviderClient();

    const result = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(result).toMatchObject({ ok: false, failures: 1, providerCalls: 0, reason: "submission_begin_down" });
    expect(port.calls.beginSubmission).toHaveLength(1);
    expect(providerClient.createOrder).not.toHaveBeenCalled();
  });

  it("leaves the draft correctable when mapped attempt evidence cannot be recorded", async () => {
    const port = fakePort([candidate()], { failProviderAttempt: true });
    const providerClient = fakeProviderClient();

    const result = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(result).toMatchObject({
      ok: false,
      failures: 1,
      providerCalls: 0,
      reason: "provider_attempt_down",
    });
    expect(port.calls.recordDispatchRef).toHaveLength(1);
    expect(port.calls.beginSubmission).toHaveLength(0);
    expect(providerClient.createOrder).not.toHaveBeenCalled();
  });

  it("repairs created provider proof locally with zero POSTs", async () => {
    const port = fakePort([candidate()], {
      initialRef: { status: "created", providerOrderId: "provider-order-1" },
    });
    const providerClient = fakeProviderClient();

    const result = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(result.providerCalls).toBe(0);
    expect(providerClient.createOrder).not.toHaveBeenCalled();
    expect(port.calls.prepareDispatchContact).toEqual([]);
    expect(port.calls.recordDispatchRef).toHaveLength(0);
    expect(port.calls.acknowledgeDispatchAcceptance[0]).toMatchObject({
      providerOrderId: "provider-order-1",
      metadata: {
        source: "omnipack_dispatch_worker_recovery",
        proof: "persisted_provider_order_id",
        noProviderPost: true,
      },
    });
  });

  it("repairs uncertain provider proof locally with zero POSTs", async () => {
    const port = fakePort([candidate()], {
      initialRef: { status: "uncertain", providerOrderId: "provider-order-1" },
    });
    const providerClient = fakeProviderClient();

    const result = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(result).toMatchObject({ ok: true, providerCalls: 0, updated: 1 });
    expect(providerClient.createOrder).not.toHaveBeenCalled();
    expect(port.calls.acknowledgeDispatchAcceptance).toHaveLength(1);
  });

  it("withholds an unprepared contact without a provider failure or POST", async () => {
    const port = fakePort([candidate()], { prepareDisposition: "withheld" });
    const providerClient = fakeProviderClient();

    const result = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(result).toMatchObject({ ok: true, checked: 1, updated: 0, failures: 0, providerCalls: 0 });
    expect(port.calls.prepareDispatchContact).toEqual([candidate().fulfillmentOrderId]);
    expect(port.calls.readCandidateByFulfillmentOrderId).toEqual([]);
    expect(port.calls.recordDispatchRef).toEqual([]);
    expect(port.calls.recordProviderAttempt).toEqual([]);
    expect(providerClient.createOrder).not.toHaveBeenCalled();
  });

  it("rereads the canonical candidate after preparation before constructing the dispatch payload", async () => {
    const prepared = {
      ...candidate(),
      deliveryContact: deliveryContact(2),
    };
    const events: string[] = [];
    const port = fakePort([candidate()], { events, refreshedCandidate: prepared });
    const providerClient = fakeProviderClient(undefined, events);

    const result = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(result).toMatchObject({ ok: true, updated: 1, providerCalls: 1 });
    expect(events.indexOf("prepareDispatchContact")).toBeLessThan(events.indexOf("readCandidateByFulfillmentOrderId"));
    expect(events.indexOf("readCandidateByFulfillmentOrderId")).toBeLessThan(events.indexOf("recordDispatchRef"));
    expect(port.calls.recordDispatchRef[0]?.sanitizedRequest).toMatchObject({ deliveryContactRevision: 2 });
  });

  it("honors the final submission fence when candidate state changes before POST", async () => {
    const port = fakePort([candidate()], { blockBeginSubmission: true });
    const providerClient = fakeProviderClient();

    const result = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(result).toMatchObject({ ok: true, providerCalls: 0 });
    expect(port.calls.beginSubmission).toEqual([{
      dispatchRefId: "dispatch-ref-1",
      requestFingerprint: expect.any(String),
    }]);
    expect(providerClient.createOrder).not.toHaveBeenCalled();
  });

  it("remaps once when ref recording rejects a stale delivery-contact revision", async () => {
    const refreshed = {
      ...candidate(),
      deliveryContact: {
        ...deliveryContact(2),
        contactEmail: "new-contact@example.test",
      },
    };
    const port = fakePort([candidate()], {
      staleRecordFailures: 1,
      refreshedCandidate: refreshed,
    });
    const providerClient = fakeProviderClient();

    const result = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(result).toMatchObject({ ok: true, providerCalls: 1, updated: 1 });
    expect(port.calls.readCandidateByFulfillmentOrderId).toEqual([
      candidate().fulfillmentOrderId,
      candidate().fulfillmentOrderId,
    ]);
    expect(port.calls.recordDispatchRef).toHaveLength(2);
    expect(port.calls.beginSubmission).toHaveLength(1);
    expect(port.calls.recordProviderAttempt).toHaveLength(1);
    expect(providerClient.createOrder).toHaveBeenCalledTimes(1);
  });

  it("remaps once when the final begin fence rejects a stale delivery-contact revision", async () => {
    const refreshed = {
      ...candidate(),
      deliveryContact: {
        ...deliveryContact(2),
        contactPhone: "+48987654321",
      },
    };
    const port = fakePort([candidate()], {
      staleBeginFailures: 1,
      refreshedCandidate: refreshed,
    });
    const providerClient = fakeProviderClient();

    const result = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(result).toMatchObject({ ok: true, providerCalls: 1, updated: 1 });
    expect(port.calls.readCandidateByFulfillmentOrderId).toEqual([
      candidate().fulfillmentOrderId,
      candidate().fulfillmentOrderId,
    ]);
    expect(port.calls.recordDispatchRef).toHaveLength(2);
    expect(port.calls.beginSubmission).toHaveLength(2);
    expect(port.calls.recordProviderAttempt.map((attempt) => attempt.idempotencyKey)).toEqual([
      `${dispatchIdempotencyKey(candidate().fulfillmentOrderId)}:attempt`,
      `${dispatchIdempotencyKey(candidate().fulfillmentOrderId)}:attempt:contact-remap`,
    ]);
    expect(providerClient.createOrder).toHaveBeenCalledTimes(1);
  });

  it("does not remap twice or POST when the stale revision refusal repeats", async () => {
    const port = fakePort([candidate()], {
      staleRecordFailures: 2,
      refreshedCandidate: { ...candidate(), deliveryContact: deliveryContact(2) },
    });
    const providerClient = fakeProviderClient();

    const result = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(result).toMatchObject({
      ok: false,
      failures: 1,
      providerCalls: 0,
      reason: OMNIPACK_DISPATCH_CONTACT_STALE,
    });
    expect(port.calls.readCandidateByFulfillmentOrderId).toHaveLength(2);
    expect(port.calls.recordProviderAttempt).toHaveLength(0);
    expect(providerClient.createOrder).not.toHaveBeenCalled();
  });

  it.each(["uncertain", "failed", "submitting"] as const)(
    "never blindly retries a %s dispatch without provider proof",
    async (status) => {
      const port = fakePort([candidate()], { initialRef: { status, providerOrderId: null } });
      const providerClient = fakeProviderClient();

      const result = await runOmnipackDispatchWorker({
        port,
        providerClient,
        config: { mode: "stage", batchLimit: 10 },
      });

      expect(result).toMatchObject({
        ok: false,
        providerCalls: 0,
        reason: `omnipack_dispatch_not_safe_to_submit:${status}`,
      });
      expect(providerClient.createOrder).not.toHaveBeenCalled();
      expect(port.calls.beginSubmission).toHaveLength(0);
    },
  );

  it.each([
    { name: "timeout", error: providerError({ status: null, code: "timeout", mayHaveSucceeded: true }) },
    { name: "network failure", error: providerError({ status: null, code: "network_error", mayHaveSucceeded: true }) },
    { name: "HTTP 503", error: providerError({ status: 503, code: "http_503", mayHaveSucceeded: true }) },
  ])("stores $name as uncertain after exactly one POST", async ({ error }) => {
    const port = fakePort([candidate()]);
    const providerClient = fakeProviderClient(error);

    const result = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(result).toMatchObject({ ok: false, failures: 1, providerCalls: 1 });
    expect(providerClient.createOrder).toHaveBeenCalledTimes(1);
    expect(port.calls.finalizeSubmission[0]).toMatchObject({
      providerOrderId: null,
      mayHaveSucceeded: true,
      error: { mayHaveSucceeded: true },
    });
  });

  it("stores a malformed successful provider response as internally consistent uncertain evidence", async () => {
    const port = fakePort([candidate()]);
    const malformedResponse = new Error("omnipack_order_response_invalid");
    const providerClient = fakeProviderClient(malformedResponse);

    const result = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(result).toMatchObject({ ok: false, failures: 1, providerCalls: 1 });
    expect(providerClient.createOrder).toHaveBeenCalledOnce();
    expect(port.calls.finalizeSubmission).toEqual([
      expect.objectContaining({
        providerOrderId: null,
        mayHaveSucceeded: true,
        error: expect.objectContaining({
          code: "Error",
          mayHaveSucceeded: true,
          message: "omnipack_order_response_invalid",
        }),
      }),
    ]);
  });

  it("stores a definite HTTP 400 rejection as failed after exactly one POST", async () => {
    const port = fakePort([candidate()]);
    const providerClient = fakeProviderClient(providerError({
      status: 400,
      code: "bad_request",
      retryable: false,
      mayHaveSucceeded: false,
    }));

    const result = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(result).toMatchObject({
      ok: false,
      failures: 1,
      providerCalls: 1,
      reason: "omnipack_provider_create_order_non_retryable:bad_request",
    });
    expect(providerClient.createOrder).toHaveBeenCalledTimes(1);
    expect(port.calls.finalizeSubmission[0]).toMatchObject({
      mayHaveSucceeded: false,
      error: { code: "bad_request", retryable: false, mayHaveSucceeded: false, status: 400 },
    });
  });

  it("stores accepted proof as uncertain when atomic ack fails, then locally repairs without a second POST", async () => {
    const port = fakePort([candidate()], { ackFailures: 1 });
    const providerClient = fakeProviderClient();

    const first = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });
    const second = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(first).toMatchObject({
      ok: false,
      failures: 1,
      providerCalls: 1,
      reason: "omnipack_dispatch_proof_write_failed_after_provider_acceptance",
    });
    expect(port.calls.finalizeSubmission[0]).toMatchObject({
      providerOrderId: "provider-order-1",
      mayHaveSucceeded: true,
      error: { code: "omnipack_dispatch_acceptance_write_failed", mayHaveSucceeded: true },
    });
    expect(second).toMatchObject({ ok: true, providerCalls: 0, updated: 1 });
    expect(providerClient.createOrder).toHaveBeenCalledTimes(1);
    expect(port.calls.acknowledgeDispatchAcceptance).toHaveLength(2);
  });

  it("treats an acknowledged-but-response-lost commit as success and never regresses or re-POSTs", async () => {
    const port = fakePort([candidate()], { ackCommitThenFailures: 1 });
    const providerClient = fakeProviderClient();

    const first = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });
    const second = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(first).toMatchObject({ ok: true, failures: 0, providerCalls: 1, updated: 1 });
    expect(second).toMatchObject({ ok: true, providerCalls: 0 });
    expect(providerClient.createOrder).toHaveBeenCalledTimes(1);
    expect(port.calls.finalizeSubmission).toHaveLength(0);
    expect(port.calls.acknowledgeDispatchAcceptance).toHaveLength(2);
  });

  it("records sanitized shadow evidence without a provider call", async () => {
    const port = fakePort([candidate()]);
    const providerClient = fakeProviderClient();

    const result = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "shadow", batchLimit: 10 },
    });

    expect(result).toMatchObject({ ok: true, checked: 1, updated: 1, providerCalls: 0 });
    expect(providerClient.createOrder).not.toHaveBeenCalled();
    expect(port.calls.markStaleSubmissionsUncertain).toHaveLength(0);
    expect(port.calls.recordProviderAttempt[0]).toMatchObject({
      idempotencyKey: `${dispatchIdempotencyKey(candidate().fulfillmentOrderId)}:attempt`,
      status: "recorded",
    });
    expect(JSON.stringify(port.calls.recordDispatchRef[0]?.sanitizedRequest)).not.toMatch(
      /anna@example\.test|\+48123456789|Secretowa|Anna|Kowalska|00-001/,
    );
  });

  it("promotes an unsubmitted shadow draft and performs exactly one provider POST", async () => {
    const port = fakePort([candidate()]);
    const providerClient = fakeProviderClient();

    const shadow = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "shadow", batchLimit: 10 },
    });
    const stage = await runOmnipackDispatchWorker({
      port,
      providerClient,
      config: { mode: "stage", batchLimit: 10 },
    });

    expect(shadow).toMatchObject({ ok: true, providerCalls: 0 });
    expect(stage).toMatchObject({ ok: true, providerCalls: 1, updated: 1 });
    expect(providerClient.createOrder).toHaveBeenCalledTimes(1);
    expect(port.calls.recordDispatchRef.map((call) => call.dispatchMode)).toEqual(["shadow", "stage"]);
  });

  it("keeps sanitized evidence free of recipient and address objects", () => {
    const evidence = buildSanitizedEvidence({
      orderNumber: "ORDER-1",
      shippingDetails: {
        carrier: "DPD_COURIER_STANDARD",
        service: "DPD_COURIER_STANDARD",
        address: {
          name: "Anna Kowalska",
          street: "Secretowa 1",
          city: "Warszawa",
          postCode: "00-001",
          phone: "+48123456789",
          email: "anna@example.test",
          country: "PL",
        },
      },
      items: [{ sku: "SKU-1", quantity: 1 }],
    });

    expect(evidence).toEqual({
      provider: "omnipack",
      requestKind: "outbound_order",
      orderNumber: "ORDER-1",
      carrier: "DPD_COURIER_STANDARD",
      service: "DPD_COURIER_STANDARD",
      pickUpPoint: null,
      itemCount: 1,
      items: [{ sku: "SKU-1", quantity: 1, lotNumber: null, expirationDate: null }],
      stockTruth: "external_stock_master_with_local_reservations",
    });
    expect(JSON.stringify(evidence)).not.toMatch(/Anna|Kowalska|Secretowa|00-001|anna@example\.test|\+48123456789/);
  });

});

function candidate(): OmnipackDispatchCandidate {
  return {
    fulfillmentOrderId: "52222222-2222-4222-8222-222222222221",
    orderId: "62222222-2222-4222-8222-222222222221",
    orderNumber: "OPENLUP-1001",
    status: "created",
    deliveryContact: deliveryContact(),
    client: { email: "anna@example.test", firstName: "Anna", lastName: "Kowalska", phone: "+48123456789" },
    shippingAddress: DELIVERY_ADDRESS,
    deliverySelection: {
      kind: "courier",
      deliveryKind: "courier",
      providerKind: "omnipack",
      carrierKind: "dpd",
      carrierCode: "DPD",
      service: "dpd_courier_standard",
      serviceCode: "DPD_COURIER_STANDARD",
      pickupPoint: null,
    },
    lines: [{ sku: "OPENLUP-KARMA-ADULT-2KG", title: "Food", quantity: 2, productSnapshot: {} }],
  };
}

function deliveryContact(revision = 1) {
  return {
    ...DELIVERY_ADDRESS,
    schemaVersion: 1 as const,
    source: "checkout_submission",
    revision,
    recipientName: "Anna Kowalska",
    contactEmail: "anna@example.test",
    contactPhone: "+48123456789",
    line2: null,
    selectedDelivery: {
      kind: "courier",
      deliveryKind: "courier",
      providerKind: "omnipack",
      carrierKind: "dpd",
      carrierCode: "DPD",
      service: "dpd_courier_standard",
      serviceCode: "DPD_COURIER_STANDARD",
      pickupPoint: null,
    },
    deliveryInstructions: null,
    courierInstructions: null,
  };
}

const DELIVERY_ADDRESS = {
  label: "Dom",
  recipientName: null,
  line1: "Secretowa 1",
  city: "Warszawa",
  postalCode: "00-001",
  country: "PL",
};

interface FakePortOptions {
  events?: string[];
  initialRef?: {
    status: OmnipackDispatchRefStatus;
    providerOrderId: string | null;
    dispatchMode?: "shadow" | "stage" | "live";
  };
  failStaleSweep?: boolean;
  failProviderAttempt?: boolean;
  failBeginSubmission?: boolean;
  blockBeginSubmission?: boolean;
  staleRecordFailures?: number;
  staleBeginFailures?: number;
  refreshedCandidate?: OmnipackDispatchCandidate;
  ackFailures?: number;
  ackCommitThenFailures?: number;
  prepareDisposition?: "ready" | "withheld";
}

function fakePort(candidates: OmnipackDispatchCandidate[], options: FakePortOptions = {}) {
  const events = options.events ?? [];
  let ref: OmnipackDispatchReadBack | null = options.initialRef
    ? readBack(
        options.initialRef.status,
        options.initialRef.providerOrderId,
        options.initialRef.dispatchMode,
      )
    : null;
  let remainingAckFailures = options.ackFailures ?? 0;
  let remainingAckCommitThenFailures = options.ackCommitThenFailures ?? 0;
  let remainingStaleRecordFailures = options.staleRecordFailures ?? 0;
  let remainingStaleBeginFailures = options.staleBeginFailures ?? 0;
  const calls = {
    listCandidates: 0,
    readCandidateByFulfillmentOrderId: [] as string[],
    prepareDispatchContact: [] as string[],
    markStaleSubmissionsUncertain: [] as string[],
    recordProviderAttempt: [] as Array<Record<string, unknown>>,
    recordDispatchRef: [] as Array<Record<string, unknown>>,
    beginSubmission: [] as Array<Record<string, unknown>>,
    acknowledgeDispatchAcceptance: [] as Array<Record<string, unknown>>,
    finalizeSubmission: [] as Array<Record<string, unknown>>,
  };
  const port: OmnipackDispatchPort & { calls: typeof calls } = {
    calls,
    async listCandidates() {
      events.push("listCandidates");
      calls.listCandidates += 1;
      return candidates;
    },
    async readCandidateByFulfillmentOrderId(fulfillmentOrderId) {
      events.push("readCandidateByFulfillmentOrderId");
      calls.readCandidateByFulfillmentOrderId.push(fulfillmentOrderId);
      return options.refreshedCandidate
        ?? candidates.find((item) => item.fulfillmentOrderId === fulfillmentOrderId)
        ?? null;
    },
    async prepareDispatchContact(fulfillmentOrderId) {
      events.push("prepareDispatchContact");
      calls.prepareDispatchContact.push(fulfillmentOrderId);
      return {
        disposition: options.prepareDisposition ?? "ready",
        deliveryContactRevision: options.prepareDisposition === "withheld" ? null : 1,
      };
    },
    async markStaleSubmissionsUncertain(staleBefore) {
      events.push("markStaleSubmissionsUncertain");
      calls.markStaleSubmissionsUncertain.push(staleBefore);
      if (options.failStaleSweep) throw new Error("stale_sweep_down");
      return 0;
    },
    async recordProviderAttempt(input) {
      calls.recordProviderAttempt.push(input);
      if (options.failProviderAttempt) throw new Error("provider_attempt_down");
      return { replayed: false };
    },
    async recordDispatchRef(input) {
      events.push("recordDispatchRef");
      calls.recordDispatchRef.push(input);
      if (remainingStaleRecordFailures > 0) {
        remainingStaleRecordFailures -= 1;
        throw new Error(OMNIPACK_DISPATCH_CONTACT_STALE);
      }
      const replayed = ref !== null;
      if (!ref) ref = readBack("draft", null, input.dispatchMode);
      else if (ref.status === "draft" && ref.dispatch_mode === "shadow" && input.dispatchMode !== "shadow") {
        ref = readBack("draft", ref.provider_order_id, input.dispatchMode);
      }
      return {
        dispatchRefId: ref.id,
        fulfillmentOrderId: ref.fulfillment_order_id,
        orderId: ref.order_id,
        providerOrderId: ref.provider_order_id,
        status: ref.status,
        replayed,
      };
    },
    async readDispatchRefByIdempotencyKey() {
      return ref;
    },
    async beginSubmission(input) {
      events.push("beginSubmission");
      calls.beginSubmission.push(input);
      if (remainingStaleBeginFailures > 0) {
        remainingStaleBeginFailures -= 1;
        throw new Error(OMNIPACK_DISPATCH_CONTACT_STALE);
      }
      if (options.failBeginSubmission) throw new Error("submission_begin_down");
      if (options.blockBeginSubmission) {
        return { ...ref!, begun: false, replayed: true };
      }
      ref = readBack("submitting", ref?.provider_order_id ?? null, ref?.dispatch_mode ?? "stage");
      return { ...ref, begun: true, replayed: false };
    },
    async acknowledgeDispatchAcceptance(input) {
      events.push("acknowledgeDispatchAcceptance");
      calls.acknowledgeDispatchAcceptance.push(input);
      const providerOrderId = input.providerOrderId;
      if (!providerOrderId) throw new Error("test_acceptance_requires_provider_order_id");
      if (remainingAckFailures > 0) {
        remainingAckFailures -= 1;
        throw new Error("atomic_ack_down");
      }
      ref = readBack("created", providerOrderId, ref?.dispatch_mode ?? "stage");
      if (remainingAckCommitThenFailures > 0) {
        remainingAckCommitThenFailures -= 1;
        throw new Error("atomic_ack_response_lost");
      }
      return {
        dispatchRefId: ref.id,
        fulfillmentOrderId: ref.fulfillment_order_id,
        orderId: ref.order_id,
        providerOrderId,
        dispatchStatus: "created",
        fulfillmentStatus: "label_created",
        replayed: false,
      };
    },
    async finalizeSubmission(input) {
      events.push("finalizeSubmission");
      calls.finalizeSubmission.push(input);
      ref = readBack(input.mayHaveSucceeded ? "uncertain" : "failed", input.providerOrderId, ref?.dispatch_mode ?? "stage");
      return ref;
    },
  };
  return port;
}

function readBack(
  status: OmnipackDispatchRefStatus,
  providerOrderId: string | null,
  dispatchMode: "shadow" | "stage" | "live" = "stage",
): OmnipackDispatchReadBack {
  return {
    id: "dispatch-ref-1",
    fulfillment_order_id: candidate().fulfillmentOrderId,
    order_id: candidate().orderId,
    provider_order_id: providerOrderId,
    dispatch_mode: dispatchMode,
    status,
    request_idempotency_key: dispatchIdempotencyKey(candidate().fulfillmentOrderId),
    sanitized_request: { provider: "omnipack", requestKind: "outbound_order" },
  };
}

function fakeProviderClient(error?: Error, events: string[] = []) {
  return {
    createOrder: vi.fn(async (_payload: Record<string, unknown>) => {
      events.push("createOrder");
      if (error) throw error;
      return { providerOrderId: "provider-order-1" };
    }),
  };
}

function providerError(input: {
  status: number | null;
  code: string;
  retryable?: boolean;
  mayHaveSucceeded: boolean;
}): Error {
  const error = new Error("OmniPack request failed: createOrder") as Error & {
    provider: "omnipack";
    status: number | null;
    code: string;
    retryable: boolean;
    mayHaveSucceeded: boolean;
  };
  error.provider = "omnipack";
  error.status = input.status;
  error.code = input.code;
  error.retryable = input.retryable ?? false;
  error.mayHaveSucceeded = input.mayHaveSucceeded;
  return error;
}
