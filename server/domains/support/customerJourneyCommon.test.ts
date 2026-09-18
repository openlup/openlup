import { describe, expect, it } from "vitest";
import { compact, customerName, displayLookup, gap, isConfirmedShipmentCommunication, mapCommunication } from "./customerJourneyCommon.js";

describe("customer journey common helpers", () => {
  it("requires a canonical shipment purpose before a delivery can discharge shipment evidence", () => {
    expect(isConfirmedShipmentCommunication(mapCommunication({ id: "payment", purpose: "payment_confirmation", status: "delivered" }))).toBe(false);
    expect(isConfirmedShipmentCommunication(mapCommunication({ id: "shipment", purpose: "shipment_dispatched", status: "sent" }))).toBe(true);
  });
  it("normalizes support snapshot primitives without leaking raw payloads", () => {
    expect(displayLookup({ email: "x@example.com", pageSize: 10 })).toBe("x@example.com");
    expect(customerName({ first_name: "Ala", last_name: "Kot" })).toBe("Ala Kot");
    expect(compact(["a", "a", null, "b"])).toEqual(["a", "b"]);
    expect(gap("webhook_missing", "warning", "missing", "next")).toMatchObject({ code: "webhook_missing" });
    expect(mapCommunication({ id: "email-1", provider_payload: { secret: true } })).not.toHaveProperty("provider_payload");
  });
});
