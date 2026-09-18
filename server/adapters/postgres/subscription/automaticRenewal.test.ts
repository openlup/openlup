import { describe, expect, it, vi } from "vitest";

import { createPostgresRenewalSettlementPort } from "../commerce/renewalSettlement.js";
import { createPostgresRenewalReservationPort } from "../inventory/renewalReservation.js";
import {
  automaticRenewalFingerprint,
  automaticRenewalIdentity,
  createPostgresAutomaticRenewalPort,
} from "./automaticRenewal.js";
import type { AutomaticRenewalCycleSnapshot } from "../../../domains/subscription/automaticRenewalPorts.js";

const SUBSCRIPTION_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "44444444-4444-4444-8444-444444444444";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const CLAIM_TOKEN = "33333333-3333-4333-8333-333333333333";
const SCHEDULED_AT = "2026-08-15T10:00:00.000Z";

describe("postgres automatic renewal adapters", () => {
  it("builds a stable neutral snapshot and claims it with parameterized SQL", async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes("subscription_list_due_renewals")) return { rows: [{ ...header(),
        scheduled_at: "2026-08-15 10:00:00.123456+00", cadence_days: 30 }] };
      if (sql.includes("FROM public.subscriptions")) return { rows: [header()] };
      if (sql.includes("subscription_claim_due_renewal")) return { rows: [{ response: readback() }] };
      throw new Error("unexpected query");
    });
    const port = createPostgresAutomaticRenewalPort({ query });
    await expect(port.listDue(1, SCHEDULED_AT)).resolves.toEqual([
      expect.objectContaining({ scheduledAt: "2026-08-15 10:00:00.123456+00" }),
    ]);
    expect(query.mock.calls[0]?.[0]).toContain("scheduled_at::text");
    const snapshot = await port.buildCycleSnapshots({
      subscriptionId: SUBSCRIPTION_ID, scheduledAt: SCHEDULED_AT,
    });
    expect(query.mock.calls[1]?.[0]).toContain("next_cycle_at::text");
    expect(snapshot).toMatchObject({
      contractVersion: "platform.subscription.renewal.v1",
      totalAmountMinor: 2500,
      lines: [{ sku: "SKU-1", quantity: 2, unitAmountMinor: 1250 }],
    });
    expect(automaticRenewalIdentity(SUBSCRIPTION_ID, SCHEDULED_AT)).toBe(
      `subscription:${SUBSCRIPTION_ID}:cycle:${SCHEDULED_AT}`,
    );
    expect(automaticRenewalFingerprint(snapshot)).toMatch(/^[0-9a-f]{64}$/);
    expect(automaticRenewalFingerprint({
      ...snapshot,
      lines: snapshot.lines.map((line) => ({
        unitAmountMinor: line.unitAmountMinor,
        quantity: line.quantity,
        sku: line.sku,
        lineOrdinal: line.lineOrdinal,
      })),
    })).toBe(automaticRenewalFingerprint(snapshot));
    expect(automaticRenewalFingerprint({ ...snapshot, totalAmountMinor: 2501 }))
      .not.toBe(automaticRenewalFingerprint(snapshot));
    expect(query.mock.calls.filter(([sql]) => sql.includes("FROM public.subscriptions"))).toHaveLength(1);

    await expect(port.claimDue({ snapshot, workerId: "worker-a", now: SCHEDULED_AT }))
      .resolves.toMatchObject({ operationId: OPERATION_ID, acquired: true, state: "claimed" });
    const claim = query.mock.calls.find(([sql]) => sql.includes("subscription_claim_due_renewal"));
    expect(claim?.[0]).toContain("$1::text");
    expect(claim?.[1]).toEqual([
      `subscription:${SUBSCRIPTION_ID}:cycle:${SCHEDULED_AT}`,
      automaticRenewalFingerprint(snapshot), JSON.stringify(snapshot), "worker-a", 300, SCHEDULED_AT,
    ]);
  });

  it("keeps ATP reservation/release/expiry behind narrow parameterized functions", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("fulfillment_reserve")) return { rows: [{ response: {
        reserved: true, replayed: false, reservationId: "reservation-1", status: "held", reason: null,
      } }] };
      if (sql.includes("fulfillment_release")) return { rows: [{ response: { state: "refused" } }] };
      return { rows: [{ expired: 2 }] };
    });
    const port = createPostgresRenewalReservationPort({ query });
    await expect(port.reserve({ operationId: OPERATION_ID, claimToken: CLAIM_TOKEN, now: SCHEDULED_AT }))
      .resolves.toEqual({
        reserved: true, replayed: false, reservationId: "reservation-1", status: "held", reason: null,
      });
    await expect(port.releaseReservation({
      operationId: OPERATION_ID, claimToken: CLAIM_TOKEN, reason: "operator_block", now: SCHEDULED_AT,
    })).resolves.toMatchObject({ state: "refused" });
    await expect(port.expireReservations({ now: SCHEDULED_AT })).resolves.toBe(2);
    expect(query.mock.calls.every(([sql]) => String(sql).includes("$1"))).toBe(true);
  });

  it("prepares only local artifacts and requires external acknowledgement for success", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("commerce_prepare")) return { rows: [{ response: {
        contractVersion: "platform.subscription.renewal.v1", replayed: false,
        operationId: OPERATION_ID, operationFingerprint: "a".repeat(64),
        cycleId: "cycle-1", orderId: "order-1", settlementIntentId: "intent-1",
        state: "attempt_prepared",
      } }] };
      if (sql.includes("commerce_acknowledge")) return { rows: [{ response: {
        state: "attempt_prepared", externalAttemptRef: "provider-attempt-1",
      } }] };
      return { rows: [{ response: { state: "succeeded", terminalOutcome: "succeeded" } }] };
    });
    const port = createPostgresRenewalSettlementPort({ query });
    await expect(port.prepareRenewal({
      operationId: OPERATION_ID, claimToken: CLAIM_TOKEN, now: SCHEDULED_AT,
    })).resolves.toMatchObject({ state: "attempt_prepared", settlementIntentId: "intent-1" });
    await expect(port.acknowledgeExternalAttempt({
      operationId: OPERATION_ID, operationFingerprint: "a".repeat(64),
      externalAttemptRef: "provider-attempt-1", acknowledgedAt: SCHEDULED_AT,
    })).resolves.toMatchObject({ externalAttemptRef: "provider-attempt-1" });
    await expect(port.recordTerminalOutcome({
      operationId: OPERATION_ID, eventKey: "ack-1", operationFingerprint: "a".repeat(64),
      outcome: "succeeded", occurredAt: SCHEDULED_AT,
    })).rejects.toThrow("external_ref_required");
    expect(query).toHaveBeenCalledTimes(2);
    await expect(port.recordTerminalOutcome({
      operationId: OPERATION_ID, eventKey: "ack-1", operationFingerprint: "a".repeat(64),
      outcome: "succeeded", externalRef: "opaque-ack-1", occurredAt: SCHEDULED_AT,
    })).resolves.toMatchObject({ terminalOutcome: "succeeded" });
    expect(query.mock.calls[2]?.[0]).toContain("$7::timestamptz");
  });
});

function header() {
  return {
    subscription_id: SUBSCRIPTION_ID, client_id: CLIENT_ID,
    scheduled_at: SCHEDULED_AT, cycle_number: 4,
    currency_code: "XTS", stock_source_key: "primary", settlement_channel_key: "configured",
    authorization_ref: "authorization-1", unattended_charge_authorized_at: SCHEDULED_AT,
    payer_account_ref: "payer-account-1",
    delivery_admission: "allowed", delivery_block_reason: null,
    lines: [{ lineOrdinal: 1, sku: "SKU-1", quantity: 2, unitAmountMinor: "1250" }],
  };
}

function snapshot(): AutomaticRenewalCycleSnapshot {
  return {
    contractVersion: "platform.subscription.renewal.v1", subscriptionId: SUBSCRIPTION_ID,
    clientId: CLIENT_ID,
    scheduledAt: SCHEDULED_AT, cycleNumber: 4, currency: "XTS", totalAmountMinor: 2500,
    stockSourceKey: "primary", settlementChannelKey: "configured", authorizationRef: "authorization-1",
    payerAccountRef: "payer-account-1",
    lines: [{ lineOrdinal: 1, sku: "SKU-1", quantity: 2, unitAmountMinor: 1250 }],
  };
}

function readback() {
  return {
    contractVersion: "platform.subscription.renewal.v1", acquired: true, replayed: false,
    reason: "claimed", operationId: OPERATION_ID,
    identityKey: automaticRenewalIdentity(SUBSCRIPTION_ID, SCHEDULED_AT),
    operationFingerprint: automaticRenewalFingerprint(snapshot()), subscriptionId: SUBSCRIPTION_ID,
    scheduledAt: SCHEDULED_AT, cycleNumber: 4, state: "claimed", claimToken: CLAIM_TOKEN,
    claimGeneration: 1, leaseExpiresAt: "2026-08-15T10:05:00.000Z", cycleSnapshot: snapshot(),
    externalAttemptRef: null, externalAttemptAcknowledgedAt: null,
    terminalOutcome: null, terminalReason: null, terminalAt: null, reservationId: null,
    cycleId: null, orderId: null, settlementIntentId: null,
  };
}
