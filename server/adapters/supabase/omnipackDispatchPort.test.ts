import { describe, expect, it } from "vitest";
import { createSupabaseOmnipackDispatchPort } from "./omnipackDispatchPort.js";
import type { OmnipackDispatchCandidateRow } from "./omnipackDispatchMappers.js";

describe("Supabase OmniPack dispatch port", () => {
  it("uses the server-side candidate RPC and preserves its order while hydrating candidates", async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const queryCalls: Array<{ method: string; args: unknown[] }> = [];
    const tables: string[] = [];
    const port = createSupabaseOmnipackDispatchPort({
      from(table: string) {
        tables.push(table);
        if (table !== "commerce_fulfillment_orders") throw new Error(`unexpected table ${table}`);
        return candidateQuery([candidateRow("fulfillment-1"), candidateRow("fulfillment-2")], queryCalls);
      },
      async rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args });
        if (name === "omnipack_dispatch_candidate_ids") {
          return {
            data: [
              { fulfillment_order_id: "fulfillment-2" },
              { fulfillment_order_id: "fulfillment-1" },
            ],
            error: null,
          };
        }
        throw new Error(`unexpected rpc ${name}`);
      },
    } as never);

    const candidates = await port.listCandidates(10);

    expect(rpcCalls).toEqual([{ name: "omnipack_dispatch_candidate_ids", args: { p_limit: 10 } }]);
    expect(tables).toEqual(["commerce_fulfillment_orders"]);
    expect(queryCalls).toContainEqual({ method: "in", args: ["id", ["fulfillment-2", "fulfillment-1"]] });
    expect(queryCalls.find((call) => call.method === "select")?.args[0]).toContain(
      "addresses(metadata)",
    );
    expect(candidates.map((candidate) => candidate.fulfillmentOrderId)).toEqual(["fulfillment-2", "fulfillment-1"]);
    expect(candidates[0]).toMatchObject({
      client: {
        email: "anna@example.test",
        firstName: "Anna",
        lastName: "Kowalska",
        phone: "+48123456789",
      },
      deliverySelection: {
        providerKind: "omnipack",
        carrierCode: "INPOST",
        serviceCode: "INPOST_LOCKER_STANDARD",
        pickupPoint: { id: "WAW04A" },
      },
    });
  });

  it("surfaces candidate RPC failure without starting hydration", async () => {
    const tables: string[] = [];
    const port = createSupabaseOmnipackDispatchPort({
      from(table: string) {
        tables.push(table);
        throw new Error("hydration_must_not_run");
      },
      async rpc(name: string) {
        expect(name).toBe("omnipack_dispatch_candidate_ids");
        return { data: null, error: { code: "RPC_DOWN" } };
      },
    } as never);

    await expect(port.listCandidates(25)).rejects.toThrow("omnipack_dispatch_candidates_read_failed:RPC_DOWN");
    expect(tables).toEqual([]);
  });

  it("prepares a dispatch contact through the server-side RPC without exposing contact data", async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const port = createSupabaseOmnipackDispatchPort({
      from() {
        throw new Error("direct_query_must_not_run");
      },
      async rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args });
        return { data: { disposition: "ready", deliveryContactRevision: 1 }, error: null };
      },
    } as never);

    await expect(port.prepareDispatchContact("fulfillment-1")).resolves.toEqual({
      disposition: "ready",
      deliveryContactRevision: 1,
    });
    expect(rpcCalls).toEqual([{
      name: "omnipack_prepare_dispatch_contact_v1",
      args: { p_fulfillment_order_id: "fulfillment-1" },
    }]);
  });

  it("preserves the named withheld disposition from dispatch preparation", async () => {
    const port = createSupabaseOmnipackDispatchPort({
      from() {
        throw new Error("direct_query_must_not_run");
      },
      async rpc() {
        return { data: { disposition: "withheld", deliveryContactRevision: null }, error: null };
      },
    } as never);

    await expect(port.prepareDispatchContact("fulfillment-1")).resolves.toEqual({
      disposition: "withheld",
      deliveryContactRevision: null,
    });
  });

  it.each([
    { name: "ready without a revision", data: { disposition: "ready", deliveryContactRevision: null } },
    { name: "withheld with a revision", data: { disposition: "withheld", deliveryContactRevision: 1 } },
    { name: "ready with a non-positive revision", data: { disposition: "ready", deliveryContactRevision: 0 } },
    { name: "ready with a non-integer revision", data: { disposition: "ready", deliveryContactRevision: "one" } },
  ])("rejects $name preparation readback", async ({ data }) => {
    const port = createSupabaseOmnipackDispatchPort({
      from() {
        throw new Error("direct_query_must_not_run");
      },
      async rpc() {
        return { data, error: null };
      },
    } as never);

    await expect(port.prepareDispatchContact("fulfillment-1")).rejects.toThrow(
      "omnipack_dispatch_contact_prepare_readback_invalid",
    );
  });

  it("maps stale-sweep, begin-submission and atomic-acceptance RPCs without a direct created update", async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const tables: string[] = [];
    const port = createSupabaseOmnipackDispatchPort({
      from(table: string) {
        tables.push(table);
        throw new Error(`unexpected direct table write ${table}`);
      },
      async rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args });
        if (name === "omnipack_mark_stale_dispatch_submissions_uncertain") {
          return { data: { markedUncertain: 2 }, error: null };
        }
        if (name === "omnipack_record_dispatch_ref_v2") {
          return {
            data: {
              dispatchRefId: "dispatch-ref-1",
              fulfillmentOrderId: "fulfillment-1",
              orderId: "order-1",
              providerOrderId: null,
              status: "draft",
              replayed: false,
            },
            error: null,
          };
        }
        if (name === "omnipack_begin_direct_dispatch_submission") {
          return {
            data: {
              dispatchRefId: "dispatch-ref-1",
              fulfillmentOrderId: "fulfillment-1",
              orderId: "order-1",
              providerOrderId: null,
              dispatchMode: "stage",
              status: "submitting",
              requestIdempotencyKey: "omnipack-dispatch:fulfillment-1",
              sanitizedRequest: { provider: "omnipack" },
              begun: true,
              replayed: false,
            },
            error: null,
          };
        }
        if (name === "omnipack_acknowledge_dispatch_acceptance") {
          return {
            data: {
              dispatchRefId: "dispatch-ref-1",
              fulfillmentOrderId: "fulfillment-1",
              orderId: "order-1",
              providerOrderId: "provider-order-1",
              dispatchStatus: "created",
              fulfillmentStatus: "label_created",
              replayed: false,
            },
            error: null,
          };
        }
        throw new Error(`unexpected rpc ${name}`);
      },
    } as never);

    await expect(port.markStaleSubmissionsUncertain("2026-07-15T12:00:00.000Z")).resolves.toBe(2);
    await expect(port.recordDispatchRef({
      idempotencyKey: "omnipack-dispatch:fulfillment-1",
      fulfillmentOrderId: "fulfillment-1",
      providerOrderId: null,
      dispatchMode: "stage",
      status: "draft",
      requestFingerprint: "fingerprint-1",
      sanitizedRequest: { provider: "omnipack" },
      sanitizedResponse: {},
      error: {},
    })).resolves.toMatchObject({ dispatchRefId: "dispatch-ref-1", status: "draft", replayed: false });
    await expect(port.beginSubmission({
      dispatchRefId: "dispatch-ref-1",
      requestFingerprint: "fingerprint-1",
    })).resolves.toMatchObject({
      id: "dispatch-ref-1",
      status: "submitting",
      sanitized_request: { provider: "omnipack" },
      begun: true,
      replayed: false,
    });
    await expect(port.acknowledgeDispatchAcceptance({
      dispatchRefId: "dispatch-ref-1",
      providerOrderId: "provider-order-1",
      providerAttemptIdempotencyKey: "omnipack-dispatch:fulfillment-1:provider-accepted",
      labelIdempotencyKey: "omnipack-dispatch:fulfillment-1:label-ack",
      sanitizedRequest: { provider: "omnipack", requestKind: "outbound_order" },
      sanitizedResponse: { provider: "omnipack", providerOrderId: "provider-order-1" },
      metadata: { proof: "provider_accepted_atomic_label_ack" },
    })).resolves.toMatchObject({
      dispatchRefId: "dispatch-ref-1",
      providerOrderId: "provider-order-1",
      dispatchStatus: "created",
      fulfillmentStatus: "label_created",
    });

    expect(rpcCalls).toEqual([
      {
        name: "omnipack_mark_stale_dispatch_submissions_uncertain",
        args: { p_stale_before: "2026-07-15T12:00:00.000Z" },
      },
      {
        name: "omnipack_record_dispatch_ref_v2",
        args: {
          p_idempotency_key: "omnipack-dispatch:fulfillment-1",
          p_fulfillment_order_id: "fulfillment-1",
          p_provider_order_id: null,
          p_dispatch_mode: "stage",
          p_status: "draft",
          p_request_fingerprint: "fingerprint-1",
          p_sanitized_request: { provider: "omnipack" },
          p_sanitized_response: {},
          p_error: {},
        },
      },
      {
        name: "omnipack_begin_direct_dispatch_submission",
        args: {
          p_dispatch_ref_id: "dispatch-ref-1",
          p_request_fingerprint: "fingerprint-1",
        },
      },
      {
        name: "omnipack_acknowledge_dispatch_acceptance",
        args: {
          p_dispatch_ref_id: "dispatch-ref-1",
          p_provider_order_id: "provider-order-1",
          p_provider_attempt_idempotency_key: "omnipack-dispatch:fulfillment-1:provider-accepted",
          p_label_idempotency_key: "omnipack-dispatch:fulfillment-1:label-ack",
          p_sanitized_request: { provider: "omnipack", requestKind: "outbound_order" },
          p_sanitized_response: { provider: "omnipack", providerOrderId: "provider-order-1" },
          p_metadata: { proof: "provider_accepted_atomic_label_ack" },
        },
      },
    ]);
    expect(tables).toEqual([]);
  });

  it("reads a deterministic candidate by fulfillment id", async () => {
    const queryCalls: Array<{ method: string; args: unknown[] }> = [];
    const tables: string[] = [];
    const port = createSupabaseOmnipackDispatchPort({
      from(table: string) {
        tables.push(table);
        if (table !== "commerce_fulfillment_orders") throw new Error(`unexpected table ${table}`);
        return candidateQuery([candidateRow("fulfillment-1")], queryCalls);
      },
      async rpc() {
        throw new Error("unexpected rpc");
      },
    } as never);

    const candidate = await port.readCandidateByFulfillmentOrderId("fulfillment-1");

    expect(tables).toEqual(["commerce_fulfillment_orders"]);
    expect(queryCalls).toContainEqual({ method: "eq", args: ["id", "fulfillment-1"] });
    expect(queryCalls).toContainEqual({
      method: "in",
      args: ["status", [
        "created",
        "label_pending",
        "label_created",
        "packed",
        "handed_over",
        "in_transit",
        "delivered",
      ]],
    });
    expect(candidate).toMatchObject({
      fulfillmentOrderId: "fulfillment-1",
      orderNumber: "OPENLUP-fulfillment-1",
      deliverySelection: { providerKind: "omnipack" },
    });
  });

  it("maps every persisted high-quantity fulfillment line without truncating lines or totals", async () => {
    const highQuantityLines = Array.from({ length: 6 }, (_, index) => ({
      sku: `OPENLUP-RECIPE-${index + 1}`,
      title: `Recipe ${index + 1}`,
      quantity: 99,
      product_snapshot: { source: "persisted-order" },
    }));
    const queryCalls: Array<{ method: string; args: unknown[] }> = [];
    const row = {
      ...candidateRow("fulfillment-1"),
      commerce_fulfillment_order_lines: highQuantityLines,
    };
    const port = createSupabaseOmnipackDispatchPort({
      from(table: string) {
        if (table !== "commerce_fulfillment_orders") throw new Error(`unexpected table ${table}`);
        return candidateQuery([row], queryCalls);
      },
      async rpc(name: string) {
        if (name === "omnipack_dispatch_candidate_ids") {
          return { data: [{ fulfillment_order_id: "fulfillment-1" }], error: null };
        }
        throw new Error(`unexpected rpc ${name}`);
      },
    } as never);

    const candidates = await port.listCandidates(10);

    expect(candidates[0]?.lines).toEqual(highQuantityLines.map((line) => ({
      sku: line.sku,
      title: line.title,
      quantity: line.quantity,
      productSnapshot: line.product_snapshot,
    })));
    expect(candidates[0]?.lines.reduce((sum, line) => sum + line.quantity, 0)).toBe(594);
  });

  it("finalizes an ambiguous submission only through the guarded RPC and preserves provider proof", async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const port = createSupabaseOmnipackDispatchPort({
      from(table: string) {
        throw new Error(`unexpected direct table access ${table}`);
      },
      async rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args });
        return {
          data: {
            dispatchRefId: "dispatch-ref-1",
            fulfillmentOrderId: "fulfillment-1",
            orderId: "order-1",
            providerOrderId: "provider-order-1",
            dispatchMode: "stage",
            status: "uncertain",
            requestIdempotencyKey: "omnipack-dispatch:fulfillment-1",
            sanitizedRequest: { provider: "omnipack" },
            replayed: false,
          },
          error: null,
        };
      },
    } as never);

    await expect(port.finalizeSubmission({
      dispatchRefId: "dispatch-ref-1",
      providerOrderId: "provider-order-1",
      mayHaveSucceeded: true,
      sanitizedResponse: { providerOrderId: "provider-order-1" },
      error: { code: "atomic_ack_response_lost" },
    })).resolves.toMatchObject({ status: "uncertain", provider_order_id: "provider-order-1" });

    expect(rpcCalls).toEqual([{
      name: "omnipack_finalize_dispatch_submission",
      args: {
        p_dispatch_ref_id: "dispatch-ref-1",
        p_may_have_succeeded: true,
        p_sanitized_response: { providerOrderId: "provider-order-1" },
        p_error: { code: "atomic_ack_response_lost" },
      },
    }]);
  });

  it("rejects contradictory provider proof before calling the submission finalizer", async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const port = createSupabaseOmnipackDispatchPort({
      from(table: string) {
        throw new Error(`unexpected direct table access ${table}`);
      },
      async rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args });
        throw new Error("finalizer_must_not_run");
      },
    } as never);

    await expect(port.finalizeSubmission({
      dispatchRefId: "dispatch-ref-1",
      providerOrderId: "provider-order-1",
      mayHaveSucceeded: true,
      sanitizedResponse: { providerOrderId: "provider-order-other" },
      error: { code: "atomic_ack_response_lost" },
    })).rejects.toThrow("omnipack_dispatch_submission_provider_order_mismatch");
    expect(rpcCalls).toEqual([]);
  });

  it.each([
    { operation: "record", rpc: "omnipack_record_dispatch_ref_v2" },
    { operation: "begin", rpc: "omnipack_begin_direct_dispatch_submission" },
  ])("preserves the named stale-contact refusal from $operation", async ({ rpc }) => {
    const port = createSupabaseOmnipackDispatchPort({
      from(table: string) {
        throw new Error(`unexpected direct table access ${table}`);
      },
      async rpc(name: string) {
        expect(name).toBe(rpc);
        return {
          data: null,
          error: { code: "40001", message: "omnipack_dispatch_contact_stale" },
        };
      },
    } as never);

    const action = rpc === "omnipack_record_dispatch_ref_v2"
      ? port.recordDispatchRef({
          idempotencyKey: "omnipack-dispatch:fulfillment-1",
          fulfillmentOrderId: "fulfillment-1",
          providerOrderId: null,
          dispatchMode: "stage",
          status: "draft",
          requestFingerprint: "fingerprint-1",
          sanitizedRequest: { deliveryContactRevision: 1 },
          sanitizedResponse: {},
          error: {},
        })
      : port.beginSubmission({
          dispatchRefId: "dispatch-ref-1",
          requestFingerprint: "fingerprint-1",
        });

    await expect(action).rejects.toThrow("omnipack_dispatch_contact_stale");
  });
});

function candidateRow(id: string): OmnipackDispatchCandidateRow {
  return {
    id,
    order_id: `order-${id}`,
    status: "created",
    metadata: {},
    shipping_address_snapshot: {
      label: "Dom",
      line1: "Secretowa 1",
      city: "Warszawa",
      postalCode: "00-001",
      country: "PL",
      selectedDelivery: undefined as Record<string, unknown> | undefined,
    },
    commerce_orders: { order_number: `OPENLUP-${id}`, metadata: {} },
    clients: { email: "anna@example.test", first_name: "Anna", last_name: "Kowalska", phone: "+48123456789" },
    addresses: {
      metadata: {
        selectedDelivery: {
          providerKind: "omnipack",
          kind: "parcel-locker",
          deliveryKind: "parcel-locker",
          carrierCode: "INPOST",
          serviceCode: "INPOST_LOCKER_STANDARD",
          pickupPoint: { id: "WAW04A" },
        },
      },
    },
    commerce_fulfillment_order_lines: [{
      sku: "OPENLUP-TURKEY-800G",
      title: "Food",
      quantity: 2,
      product_snapshot: {},
    }],
  };
}

function candidateQuery(rows: ReturnType<typeof candidateRow>[], calls: Array<{ method: string; args: unknown[] }>) {
  const builder = {
    select(...args: unknown[]) {
      calls.push({ method: "select", args });
      return builder;
    },
    in(...args: unknown[]) {
      calls.push({ method: "in", args });
      return builder;
    },
    eq(...args: unknown[]) {
      calls.push({ method: "eq", args });
      return builder;
    },
    order(...args: unknown[]) {
      calls.push({ method: "order", args });
      return builder;
    },
    async limit(...args: unknown[]) {
      calls.push({ method: "limit", args });
      return { data: rows, error: null };
    },
    async maybeSingle() {
      return { data: rows[0] ?? null, error: null };
    },
    update() {
      return builder;
    },
    then(resolve: (value: unknown) => void) {
      resolve({ data: rows, error: null });
    },
  };
  return builder;
}
