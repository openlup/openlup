import { describe, expect, it } from "vitest";
import { CommerceRuntimeConflictError, CommerceRuntimePersistenceError } from "../../../../src/domains/commerce/runtimePorts.js";
import { mapBatchReservations, mapReservation, mapRpcError } from "./inventoryReservationResponse.js";

const item = { orderItemId: "line-a", skuId: "sku-a", sku: "ITEM-A", quantity: 1 };
const order = { items: [item] } as Parameters<typeof mapBatchReservations>[1];
describe("reference reservation response", () => {
  it("keeps response identity, replay and per-line ordering", () => {
    const data = { reservationId: "hold-a", reservationIds: ["hold-a", 1, "hold-b"], replayed: true };
    expect(mapReservation(data, order, item)).toEqual({ reservationId: "hold-a", reservationIds: ["hold-a", "hold-b"], orderItemId: item.orderItemId, skuId: item.skuId, sku: item.sku, status: "reserved", replayed: true });
    expect(mapBatchReservations({ reservations: [{ ...data, orderItemId: item.orderItemId }] }, order)).toEqual([mapReservation(data, order, item)]);
    expect(mapReservation({ reservationId: "hold-a" }, order, item).reservationIds).toEqual(["hold-a"]);
    for (const invalid of [null, {}, { reservationId: "" }]) expect(() => mapReservation(invalid, order, item)).toThrow(CommerceRuntimePersistenceError);
    for (const invalid of [null, {}, { reservations: [] }]) expect(() => mapBatchReservations(invalid, order)).toThrow(CommerceRuntimePersistenceError);
  });
  it("scopes raw SQLSTATE only at this protected adapter boundary", () => {
    const raw = { code: "55P03", message: "inventory_admission_busy" };
    expect(mapRpcError(raw)).toMatchObject({ name: "CommerceRuntimePersistenceError", details: { code: "55P03", reason: "inventory_admission_busy" } });
    expect(mapRpcError({ code: "55P03", message: "lock unavailable" })).toMatchObject({ details: { code: "55P03", reason: "inventory_lock_unavailable" } });
    expect(mapRpcError({ code: "23505" })).toBeInstanceOf(CommerceRuntimeConflictError);
    expect(mapRpcError({ code: "XX000", message: "inventory_insufficient" })).toBeInstanceOf(CommerceRuntimeConflictError);
    expect(mapRpcError({ code: "XX000", message: "unrelated" })).toMatchObject({ name: "CommerceRuntimePersistenceError", details: { code: "XX000" } });
  });
});
