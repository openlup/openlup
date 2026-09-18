import { describe, expect, it, vi } from "vitest";
import {
  CommerceFulfillmentConflictError,
  CommerceFulfillmentPersistenceError,
} from "../../../src/domains/fulfillment/commerceFulfillmentPorts.js";
import type { PgQueryExecutor } from "./queryBuilder.js";
import { createPostgresFulfillmentShipmentSpinePort } from "./fulfillmentShipmentSpine.js";

const ORDER_ID = "42222222-2222-4222-8222-222222222221";
const SHIPMENT_ID = "52222222-2222-4222-8222-222222222221";
const AT = "2026-08-13T09:00:00.000Z";

describe("Postgres fulfillment shipment spine", () => {
  it("creates a shipment through the parameterized public rail and validates its nested response", async () => {
    const query = vi.fn(async (..._args: unknown[]) => response("created", true, { port_ready: true }));
    const port = createPostgresFulfillmentShipmentSpinePort({ query }, {
      portKey: "probe-carrier",
      requiredProviderType: "simulator",
    });

    await expect(port.createShipment({
      idempotencyKey: "spine-create",
      orderId: ORDER_ID,
      metadata: { source: "proof" },
      requestedAt: AT,
    })).resolves.toEqual(result("created", true));

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("public.fulfillment_create_shipment"),
      ["spine-create", ORDER_ID, "probe-carrier", { source: "proof" }, AT, "simulator"],
    );
    expect(String(query.mock.calls[0]?.[0])).toContain("public.fulfillment_ports");
    expect(String(query.mock.calls[0]?.[0])).toContain("routable IS TRUE");
    expect(String(query.mock.calls[0]?.[0])).toContain("$6::text IS NULL OR provider_type = $6::text");
    expect(String(query.mock.calls[0]?.[0])).not.toContain(ORDER_ID);
  });

  it("refuses a missing, unroutable or provider-mismatched port without invoking shipment creation", async () => {
    const query = vi.fn(async () => ({ rows: [{ response: null, port_ready: false }] }));
    const port = createPostgresFulfillmentShipmentSpinePort({ query }, {
      portKey: "configured-at-runtime",
      requiredProviderType: "simulator",
    });

    await expect(port.createShipment({ idempotencyKey: "spine-create", orderId: ORDER_ID }))
      .rejects.toMatchObject({
        name: CommerceFulfillmentConflictError.name,
        message: "fulfillment_port_not_ready",
        details: { reason: "fulfillment_port_not_ready", portKey: "configured-at-runtime" },
      });
    expect(query).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("configured_port.port_key IS NULL AND existing_operation.found IS NULL");
    expect(values).toEqual(["spine-create", ORDER_ID, "configured-at-runtime", {}, null, "simulator"]);
    expect(sql).not.toContain("configured-at-runtime");
  });

  it("lets the public idempotency rail replay an existing create after the port is disabled", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) =>
      response("created", true, { port_ready: true }));
    const port = createPostgresFulfillmentShipmentSpinePort({ query }, {
      portKey: "disabled-after-commit",
      requiredProviderType: "simulator",
    });

    await expect(port.createShipment({ idempotencyKey: "spine-create", orderId: ORDER_ID }))
      .resolves.toEqual(result("created", true));
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("existing_operation");
    expect(sql).toContain("configured_port.port_key IS NULL AND existing_operation.found IS NULL");
  });

  it("walks packed -> label_pending -> label_created and records optional label evidence", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => response(
      sql.includes("fulfillment_record_evidence") ? "label_created" : String(values?.[2]),
    ));
    const port = createPostgresFulfillmentShipmentSpinePort({ query }, {
      portKey: "probe-carrier",
      evidenceChannel: "poll",
    });

    await expect(port.recordLabel({
      idempotencyKey: "spine-label",
      shipmentId: SHIPMENT_ID,
      externalRef: "LABEL-1",
      metadata: { sanitized: true },
      requestedAt: AT,
    })).resolves.toEqual(result("label_created"));

    expect(query.mock.calls).toEqual([
      [expect.stringContaining("public.fulfillment_advance_shipment"), [
        "spine-label:packed", SHIPMENT_ID, "packed", { sanitized: true }, AT,
      ]],
      [expect.stringContaining("public.fulfillment_advance_shipment"), [
        "spine-label:label-pending", SHIPMENT_ID, "label_pending", { sanitized: true }, AT,
      ]],
      [expect.stringContaining("public.fulfillment_advance_shipment"), [
        "spine-label:label-created", SHIPMENT_ID, "label_created", { sanitized: true }, AT,
      ]],
      [expect.stringContaining("public.fulfillment_record_evidence"), [
        "spine-label:label-evidence", SHIPMENT_ID, "poll", "label", "LABEL-1",
        { sanitized: true }, AT,
      ]],
    ]);
  });

  it("does not invent evidence calls when the channel or external reference is absent", async () => {
    const withoutChannel = vi.fn(async (_sql: string, values?: unknown[]) => response(String(values?.[2])));
    const withoutReference = vi.fn(async (_sql: string, values?: unknown[]) => response(String(values?.[2])));

    await createPostgresFulfillmentShipmentSpinePort(
      { query: withoutChannel },
      { portKey: "probe-carrier" },
    ).recordLabel({ idempotencyKey: "spine-label-a", shipmentId: SHIPMENT_ID, externalRef: "LABEL-1" });
    await createPostgresFulfillmentShipmentSpinePort(
      { query: withoutReference },
      { portKey: "probe-carrier", evidenceChannel: "poll" },
    ).recordTracking({ idempotencyKey: "spine-track-a", shipmentId: SHIPMENT_ID, status: "in_transit" });

    expect(withoutChannel).toHaveBeenCalledTimes(3);
    expect(withoutReference).toHaveBeenCalledTimes(1);
    expect([...withoutChannel.mock.calls, ...withoutReference.mock.calls]
      .some(([sql]) => String(sql).includes("fulfillment_record_evidence"))).toBe(false);
  });

  it("records tracking evidence before advancing, including the delivered transition", async () => {
    const query = vi.fn(async (_sql: string, values?: unknown[]) => response(
      String(values?.[2]) === "delivered" ? "delivered" : "evidence_recorded",
    ));
    const port = createPostgresFulfillmentShipmentSpinePort({ query }, {
      portKey: "probe-house",
      evidenceChannel: "push",
    });

    await expect(port.recordTracking({
      idempotencyKey: "spine-track",
      shipmentId: SHIPMENT_ID,
      status: "delivered",
      externalRef: "TRACK-1",
      requestedAt: AT,
    })).resolves.toEqual(result("delivered"));

    expect(query.mock.calls).toEqual([
      [expect.stringContaining("public.fulfillment_record_evidence"), [
        "spine-track:tracking-evidence", SHIPMENT_ID, "push", "tracking", "TRACK-1", {}, AT,
      ]],
      [expect.stringContaining("public.fulfillment_advance_shipment"), [
        "spine-track", SHIPMENT_ID, "delivered", {}, AT,
      ]],
    ]);
  });

  it("maps handoff, cancel and exception to their fixed public functions", async () => {
    const query = vi.fn(async (_sql: string, values?: unknown[]) => {
      const status = String(values?.[2]);
      return response(status === "handed_over" ? status : status === "operator" ? "cancelled" : "exception");
    });
    const port = createPostgresFulfillmentShipmentSpinePort({ query }, { portKey: "probe-carrier" });

    await port.handOff({ idempotencyKey: "spine-handoff", shipmentId: SHIPMENT_ID, requestedAt: AT });
    await port.cancel({ idempotencyKey: "spine-cancel", shipmentId: SHIPMENT_ID, reason: "operator", requestedAt: AT });
    await port.raiseException({ idempotencyKey: "spine-exception", shipmentId: SHIPMENT_ID, reason: "provider rejected", requestedAt: AT });

    expect(query.mock.calls).toEqual([
      [expect.stringContaining("public.fulfillment_advance_shipment"), [
        "spine-handoff", SHIPMENT_ID, "handed_over", {}, AT,
      ]],
      [expect.stringContaining("public.fulfillment_cancel_shipment"), [
        "spine-cancel", SHIPMENT_ID, "operator", {}, AT,
      ]],
      [expect.stringContaining("public.fulfillment_raise_shipment_exception"), [
        "spine-exception", SHIPMENT_ID, "provider rejected", {}, AT,
      ]],
    ]);
  });

  it.each([
    { response: null },
    { response: { contractVersion: "wrong", shipment: { id: SHIPMENT_ID, orderId: ORDER_ID, status: "created" }, replayed: false } },
    { response: { contractVersion: "platform.fulfillment.shipment.v1", shipment: null, replayed: false } },
    { response: { contractVersion: "platform.fulfillment.shipment.v1", shipment: { id: SHIPMENT_ID, orderId: ORDER_ID }, replayed: false } },
    { response: { contractVersion: "platform.fulfillment.shipment.v1", shipment: { id: SHIPMENT_ID, orderId: ORDER_ID, status: "created" }, replayed: "false" } },
  ])("fails closed on malformed nested response %#", async (row) => {
    const port = createPostgresFulfillmentShipmentSpinePort({
      query: vi.fn(async (..._args: unknown[]) => ({ rows: [{ ...row, port_ready: true }] })),
    }, { portKey: "probe-carrier" });

    await expect(port.createShipment({ idempotencyKey: "spine-create", orderId: ORDER_ID }))
      .rejects.toBeInstanceOf(CommerceFulfillmentPersistenceError);
  });

  it.each(["22023", "23505"])("maps SQLSTATE %s to the neutral conflict", async (code) => {
    const port = createPostgresFulfillmentShipmentSpinePort(failingExecutor({ code }), { portKey: "probe-carrier" });
    await expect(port.handOff({ idempotencyKey: "spine-handoff", shipmentId: SHIPMENT_ID }))
      .rejects.toMatchObject({
        name: CommerceFulfillmentConflictError.name,
        details: { code },
      });
  });

  it.each([{ code: "08006" }, { code: "XX000" }, new Error("socket closed")])(
    "maps transport or unknown failure %j to neutral persistence",
    async (failure) => {
      const port = createPostgresFulfillmentShipmentSpinePort(failingExecutor(failure), { portKey: "probe-carrier" });
      await expect(port.handOff({ idempotencyKey: "spine-handoff", shipmentId: SHIPMENT_ID }))
        .rejects.toBeInstanceOf(CommerceFulfillmentPersistenceError);
    },
  );

  it("rejects invalid constructor configuration before database work", () => {
    const executor = { query: vi.fn() } as unknown as PgQueryExecutor;
    expect(() => createPostgresFulfillmentShipmentSpinePort(executor, { portKey: "  " }))
      .toThrow("fulfillment_shipment_spine_port_key_required");
    expect(() => createPostgresFulfillmentShipmentSpinePort(executor, {
      portKey: "probe-carrier",
      evidenceChannel: "webhook" as never,
    })).toThrow("fulfillment_shipment_spine_evidence_channel_invalid");
    expect(executor.query).not.toHaveBeenCalled();
  });
});

function response(status: string, replayed = false, row: Record<string, unknown> = {}) {
  return {
    rows: [{ ...row, response: {
      contractVersion: "platform.fulfillment.shipment.v1",
      shipment: { id: SHIPMENT_ID, orderId: ORDER_ID, status, providerType: "direct-carrier" },
      outcome: status,
      replayed,
    } }],
  };
}

function result(status: string, replayed = false) {
  return { shipmentId: SHIPMENT_ID, orderId: ORDER_ID, status, replayed };
}

function failingExecutor(failure: unknown): PgQueryExecutor {
  return {
    async query() {
      throw failure;
    },
  };
}
