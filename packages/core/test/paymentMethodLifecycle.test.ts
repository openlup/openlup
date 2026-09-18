import { describe, expect, it } from "vitest";
import {
  PAYMENT_METHOD_LIFECYCLE_EVENT_KINDS,
  endsStoredMethodUsability,
  expiryInstantFromMonthYear,
  isPaymentMethodLifecycleEventKind,
  type PaymentMethodLifecycleEvent,
  type PaymentMethodLifecycleEventKind,
} from "../src/payment/index.js";

describe("payment method lifecycle vocabulary", () => {
  it("publishes exactly the five transitions a rail may report", () => {
    expect([...PAYMENT_METHOD_LIFECYCLE_EVENT_KINDS]).toEqual([
      "method_registered",
      "method_updated",
      "method_revoked",
      "method_expired",
      "method_suspended",
    ]);
  });

  // The pin the whole wave stands on. A rotation carries the SAME consent under
  // fresh details; answering true here would strip a healthy subscription of
  // the method it renews on, which is a self-inflicted outage rather than a
  // detection.
  it.each<[PaymentMethodLifecycleEventKind, boolean]>([
    ["method_registered", false],
    ["method_updated", false],
    ["method_revoked", true],
    ["method_expired", true],
    ["method_suspended", true],
  ])("classifies %s as usability-ending=%s", (kind, ends) => {
    expect(endsStoredMethodUsability(kind)).toBe(ends);
  });

  it("recognises published kinds and refuses anything else", () => {
    for (const kind of PAYMENT_METHOD_LIFECYCLE_EVENT_KINDS) {
      expect(isPaymentMethodLifecycleEventKind(kind)).toBe(true);
    }
    for (const value of ["method_deleted", "", "METHOD_REVOKED", 3, null, undefined, {}]) {
      expect(isPaymentMethodLifecycleEventKind(value)).toBe(false);
    }
  });

  it("accepts an event that carries no fresh facts", () => {
    const event: PaymentMethodLifecycleEvent = {
      kind: "method_revoked",
      providerKind: "rail-a",
      providerMethodRef: "ref-1",
      providerEventId: "evt-1",
      occurredAt: "2026-08-07T10:00:00.000Z",
    };
    expect(event.replacement).toBeUndefined();
  });
});

describe("expiry instant convention", () => {
  // The documented convention: valid THROUGH the named month, so the method
  // dies at the last instant of it, in UTC.
  it.each([
    [6, 2027, "2027-06-30T23:59:59.999Z"],
    [1, 2026, "2026-01-31T23:59:59.999Z"],
    [2, 2028, "2028-02-29T23:59:59.999Z"],
    [2, 2027, "2027-02-28T23:59:59.999Z"],
    [12, 2030, "2030-12-31T23:59:59.999Z"],
  ])("folds %d/%d into %s", (month, year, expected) => {
    expect(expiryInstantFromMonthYear(month, year)).toBe(expected);
  });

  it("rolls a December expiry into the following year without an off-by-one", () => {
    expect(expiryInstantFromMonthYear(12, 2026)).toBe("2026-12-31T23:59:59.999Z");
  });

  it.each([
    [0, 2027],
    [13, 2027],
    [6.5, 2027],
    [6, 27],
    [6, 999],
    [6, 10000],
    [null, 2027],
    [6, null],
    [undefined, undefined],
  ])("refuses %s/%s rather than fabricating a date", (month, year) => {
    expect(expiryInstantFromMonthYear(month as number | null, year as number | null)).toBeNull();
  });

  it("never returns an instant inside the following month", () => {
    const value = expiryInstantFromMonthYear(6, 2027);
    expect(value).not.toBeNull();
    expect(Date.parse(value as string)).toBeLessThan(Date.parse("2027-07-01T00:00:00.000Z"));
    expect(Date.parse(value as string)).toBeGreaterThan(Date.parse("2027-06-30T23:59:59.000Z"));
  });
});
