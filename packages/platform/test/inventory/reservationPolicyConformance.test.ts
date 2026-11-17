import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CHECKOUT_RESERVATION_TTL_MINUTES,
  MAX_CHECKOUT_RESERVATION_TTL_MINUTES,
  MIN_CHECKOUT_RESERVATION_TTL_MINUTES,
  createPostgresRenewalReservationPort,
  normalizedTtlMinutes,
  reservationPolicyFor,
  type AutomaticRenewalInventoryPort,
  type CheckoutReservationLifetimePolicy,
} from "../../src/inventory/index.js";
import type {
  AutomaticRenewalReservationResult,
  ReservationPolicy,
  ReservationPolicyInput,
} from "../../src/inventory/contracts/index.js";

const now = "2026-10-20T10:00:00.000Z";
const claim = { operationId: "operation-a", claimToken: "claim-a", now };

describe("reservation policy and native renewal store conformance", () => {
  it("preserves checkout clamping and leaves every other hold without policy expiry", () => {
    expect(MIN_CHECKOUT_RESERVATION_TTL_MINUTES).toBe(1440);
    expect(MAX_CHECKOUT_RESERVATION_TTL_MINUTES).toBe(2160);
    expect(DEFAULT_CHECKOUT_RESERVATION_TTL_MINUTES).toBe(1440);
    for (const value of [undefined, null, 0, -1, NaN, Infinity, -Infinity]) {
      expect(normalizedTtlMinutes(value)).toBe(1440);
    }
    expect([1, 1440, 1800.9, 3000].map(value => normalizedTtlMinutes(value))).toEqual([1440, 1440, 1800, 2160]);
    const input: ReservationPolicyInput = { reservationKind: "checkout_payment_window",
      paymentTargetKind: "one_time_order", orderMode: "one_time", now: new Date(now), checkoutTtlMinutes: 1800.9 };
    const policy: ReservationPolicy = reservationPolicyFor(input);
    expect(policy).toEqual({ expiresAt: "2026-10-21T16:00:00.000Z", ttlMinutes: 1800 });
    for (const reservationKind of ["subscription_retry_window", "manual_ops", "other"]) {
      expect(reservationPolicyFor({ ...input, reservationKind })).toEqual({ expiresAt: null, ttlMinutes: null });
    }
    expect(input.now.toISOString()).toBe(now);
  });

  it.each([
    [undefined, 1440], [null, 1440], [0, 1440], [-1, 1440], [NaN, 1440],
    [Infinity, 1440], [-Infinity, 1440], [0.5, 1440], [1, 1440], [1440, 1440],
    [1800.9, 1800], [2160, 2160], [3000, 2160], [Number.MAX_SAFE_INTEGER, 2160], [Number.MAX_VALUE, 2160],
  ])("keeps default and explicit adopter lifetimes identical for %s", (value, expected) => {
    const adopterPolicy: CheckoutReservationLifetimePolicy = { minMinutes: 1440, maxMinutes: 2160, defaultMinutes: 1440 };
    const expiry = { 1440: "2026-10-21T10:00:00.000Z", 1800: "2026-10-21T16:00:00.000Z", 2160: "2026-10-21T22:00:00.000Z" };
    expect(normalizedTtlMinutes(value)).toBe(expected);
    expect(normalizedTtlMinutes(value, adopterPolicy)).toBe(expected);
    for (const reservationKind of ["checkout_payment_window", "subscription_retry_window"]) {
      const input: ReservationPolicyInput = { reservationKind, paymentTargetKind: "one_time_order",
        orderMode: "one_time", now: new Date(now), checkoutTtlMinutes: value };
      expect(reservationPolicyFor(input)).toEqual(reservationKind === "checkout_payment_window"
        ? { expiresAt: expiry[expected as keyof typeof expiry], ttlMinutes: expected }
        : { expiresAt: null, ttlMinutes: null });
      expect(reservationPolicyFor(input, adopterPolicy)).toEqual(reservationPolicyFor(input));
    }
  });

  it("uses custom bounds and fallback only for checkout payment windows", () => {
    const policy: CheckoutReservationLifetimePolicy = { minMinutes: 10, maxMinutes: 60, defaultMinutes: 30 };
    for (const value of [undefined, null, 0, -1, NaN, Infinity]) expect(normalizedTtlMinutes(value, policy)).toBe(30);
    expect([0.5, 1, 10, 45.9, 60, Number.MAX_VALUE].map(value => normalizedTtlMinutes(value, policy)))
      .toEqual([10, 10, 10, 45, 60, 60]);
    const input: ReservationPolicyInput = { reservationKind: "checkout_payment_window", paymentTargetKind: "one_time_order",
      orderMode: "one_time", now: new Date(now), checkoutTtlMinutes: 100 };
    expect(reservationPolicyFor(input, policy)).toEqual({ expiresAt: "2026-10-20T11:00:00.000Z", ttlMinutes: 60 });
    expect(reservationPolicyFor({ ...input, reservationKind: "subscription_retry_window" }, policy))
      .toEqual({ expiresAt: null, ttlMinutes: null });
    expect(normalizedTtlMinutes(10, { minMinutes: 1, maxMinutes: 1, defaultMinutes: 1 })).toBe(1);
  });

  it("refuses malformed or unordered policies on every helper call, including other reservation kinds", () => {
    const valid: CheckoutReservationLifetimePolicy = { minMinutes: 10, maxMinutes: 60, defaultMinutes: 30 };
    const invalid: unknown[] = [null, {}, { ...valid, minMinutes: 61 }, { ...valid, defaultMinutes: 9 }, { ...valid, defaultMinutes: 61 }];
    for (const field of ["minMinutes", "maxMinutes", "defaultMinutes"] as const) {
      for (const value of [0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "30", null, undefined]) {
        invalid.push({ ...valid, [field]: value });
      }
    }
    for (const candidate of invalid) {
      const policy = candidate as CheckoutReservationLifetimePolicy;
      expect(() => normalizedTtlMinutes(null, policy)).toThrow("reservation_policy_invalid");
      for (const reservationKind of ["checkout_payment_window", "subscription_retry_window"]) {
        expect(() => reservationPolicyFor({ reservationKind, paymentTargetKind: "one_time_order",
          orderMode: "one_time", now: new Date(now) }, policy)).toThrow("reservation_policy_invalid");
      }
    }
  });

  it("preserves reserve statuses, replay and exact fenced arguments without changing identity", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ response: {
      reserved: true, replayed: true, reservationId: " reservation-a ", status: " held ", reason: " " } }] }));
    const port: AutomaticRenewalInventoryPort = createPostgresRenewalReservationPort({ query });
    const result: AutomaticRenewalReservationResult = await port.reserve(claim);
    expect(result).toEqual({ reserved: true, replayed: true, reservationId: "reservation-a", status: "held", reason: null });
    expect(query.mock.calls[0]).toEqual([
      "SELECT public.fulfillment_reserve_subscription_renewal(\n  $1::uuid, $2::uuid, $3::integer, $4::timestamptz) AS response",
      ["operation-a", "claim-a", 900, now],
    ]);
    for (const status of ["held", "committed", "consumed", "released", "expired", "refused"] as const) {
      query.mockResolvedValueOnce({ rows: [{ response: { reserved: false, replayed: false,
        reservationId: "", status, reason: " stock_unavailable " } }] });
      await expect(port.reserve({ ...claim, holdSeconds: 37 })).resolves.toEqual({
        reserved: false, replayed: false, reservationId: null, status, reason: "stock_unavailable" });
      expect(query.mock.calls.at(-1)?.[1]).toEqual(["operation-a", "claim-a", 37, now]);
    }
    expect(claim).toEqual({ operationId: "operation-a", claimToken: "claim-a", now });
  });

  it("forwards release readback and expiry counts with unchanged defaults and overrides", async () => {
    const response = { state: "refused", replayed: true, reason: "operator_block" };
    const query = vi.fn(async (_sql: string, _values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: [{ response }] }));
    const port = createPostgresRenewalReservationPort({ query });
    await expect(port.releaseReservation({ ...claim, reason: "operator_block" })).resolves.toBe(response);
    expect(query.mock.calls[0]).toEqual([
      "SELECT public.fulfillment_release_subscription_renewal(\n  $1::uuid, $2::uuid, $3::text, $4::timestamptz) AS response",
      ["operation-a", "claim-a", "operator_block", now],
    ]);
    query.mockResolvedValueOnce({ rows: [{ expired: "2" }] });
    await expect(port.expireReservations({ now })).resolves.toBe(2);
    expect(query.mock.calls[1]).toEqual([
      "SELECT public.fulfillment_expire_subscription_renewals(\n  $1::timestamptz, $2::integer) AS expired", [now, 100],
    ]);
    query.mockResolvedValueOnce({ rows: [{ expired: 0 }] });
    await expect(port.expireReservations({ now, limit: 7 })).resolves.toBe(0);
    expect(query.mock.calls[2]?.[1]).toEqual([now, 7]);
  });

  it("rejects malformed readback and propagates database refusal without fallback or retry", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: [] }));
    const port = createPostgresRenewalReservationPort({ query });
    for (const response of [undefined, null, [], "held"]) {
      query.mockResolvedValueOnce({ rows: [{ response }] });
      await expect(port.reserve(claim)).rejects.toThrow("subscription_renewal_reserve_response_invalid");
      query.mockResolvedValueOnce({ rows: [{ response }] });
      await expect(port.releaseReservation({ ...claim, reason: "cancel" })).rejects.toThrow("subscription_renewal_release_response_invalid");
    }
    query.mockResolvedValueOnce({ rows: [{ response: { status: "reserved" } }] });
    await expect(port.reserve(claim)).rejects.toThrow("subscription_renewal_reservation_status_invalid");
    for (const expired of [undefined, -1, 0.5, "invalid", Number.MAX_SAFE_INTEGER + 1]) {
      query.mockResolvedValueOnce({ rows: [{ expired }] });
      await expect(port.expireReservations({ now })).rejects.toThrow("subscription_renewal_expiry_response_invalid");
    }
    const busy = Object.assign(new Error("reservation_busy"), { code: "55P03" });
    query.mockClear();
    query.mockRejectedValue(busy);
    await expect(port.reserve(claim)).rejects.toBe(busy);
    await expect(port.releaseReservation({ ...claim, reason: "cancel" })).rejects.toBe(busy);
    await expect(port.expireReservations({ now })).rejects.toBe(busy);
    expect(query).toHaveBeenCalledTimes(3);
  });
});
