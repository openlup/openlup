import { expect, it, vi } from "vitest";
import {
  projectCustomer360Snapshot,
  deriveContactHealth,
  boundedCustomerJourneyAudit,
  createCustomer360ReadFacade
} from "../../src/account-support/index.js";
import type { Customer360ProjectionInput, CustomerJourneyAuditEvent } from "../../src/account-support/index.js";

const policy = { lifecycle: () => [], timelineAudit: () => [] };

function input(): Customer360ProjectionInput<{ value: string }> {
  return {
    subject: {
      subjectId: "s",
      displayName: null,
      email: null,
      lifecycleStage: "customer",
      createdAt: null,
      lastActivityAt: null
    },
    legacy: null,
    cases: [{ id: "c", subscription_id: "sub", client_id: "owner", order_id: "o", status: "open" }],
    notices: [],
    tokens: [{ case_id: "c", expires_at: "2031-01-01T00:00:00Z" }],
    recoveryAudit: [],
    orderTruth: [{ id: "o", client_id: "foreign", status: "pending_payment" }],
    now: Date.parse("2030-01-01T00:00:00Z")
  };
}

it.each([
  { name: "unread", profile: undefined, warning: undefined },
  { name: "failed", profile: false as const, warning: "evidence_unavailable:customer_profile" },
  { name: "partial", profile: { extension: { value: "host" }, partial: true }, warning: "evidence_partial:customer_profile" }
])("retains profile enrichment: $name", ({ profile, warning }) => {
  const core = projectCustomer360Snapshot({ ...input(), profile }, policy);
  if (profile && typeof profile === "object") expect(core.extension).toEqual({ value: "host" });
  else expect(core).not.toHaveProperty("extension");
  expect(core).not.toHaveProperty("contactHealth");
  expect(core.subject).not.toHaveProperty("hasSignedIn");
  if (warning) expect(core.lookup.warnings).toContain(warning);
});
it.each([
  { clientId: "foreign", expected: "unavailable", available: false },
  { clientId: "owner", expected: "available", available: true }
])("retains same-client pending-order recovery: $clientId", ({ clientId, expected, available }) => {
  const value = input();
  const core = projectCustomer360Snapshot({ ...value,
    orderTruth: [{ id: "o", client_id: clientId, status: "pending_payment" }]
  }, policy);
  expect(core.recovery[0]).toMatchObject({ status: expected, actionAvailable: available });
});
it("preserves selected-empty addresses and explicit false sign-in", () => {
  const core = projectCustomer360Snapshot({ ...input(), addresses: [], signedIn: false }, policy);
  expect(core.addresses).toEqual([]);
  expect(core.subject.hasSignedIn).toBe(false);
});
const legacy: NonNullable<Customer360ProjectionInput["legacy"]> = {
  lookup: { warnings: [] }, customer: { authUserLinked: false }, orders: [],
  subscriptions: [{ subscriptionId: "sub", status: null, nextCycleAt: null, renewalOrders: [] }],
  payment: { status: null, intents: [] }, timeline: []
};
it.each([
  { name: "populated", pointers: new Map([["sub", { shippingAddressId: "address", paymentMethodKind: "card" }]]),
    expected: { shippingAddressId: "address", paymentMethodKind: "card" } },
  { name: "selected null", pointers: new Map([["sub", { shippingAddressId: null, paymentMethodKind: null }]]),
    expected: { shippingAddressId: null, paymentMethodKind: null } },
  { name: "selected empty", pointers: new Map(), expected: { shippingAddressId: null, paymentMethodKind: null } },
  { name: "unread null", pointers: null, expected: undefined },
  { name: "unread undefined", pointers: undefined, expected: undefined }
])("retains subscription pointer evidence: $name", ({ pointers, expected }) => {
  const subscription = projectCustomer360Snapshot({ ...input(), legacy, subscriptionPointers: pointers }, policy).subscriptions[0];
  if (expected) expect(subscription).toMatchObject(expected);
  else {
    expect(subscription).not.toHaveProperty("paymentMethodKind");
    expect(subscription).not.toHaveProperty("shippingAddressId");
  }
});
it.each([
  { status: "blocked", permanentBounce: null, expected: { lastTerminalStatus: null } },
  { status: "bounced", permanentBounce: false, expected: { reachable: true } }
])("derives contact health for $status", ({ status, permanentBounce, expected }) => {
  expect(deriveContactHealth([{ status, occurredAt: "2030-01-01", permanentBounce }])).toMatchObject(expected);
});
it(
  "bounds audit to the newest 80 in chronological order",
  async () => {
    const events: CustomerJourneyAuditEvent[] = Array.from(
      { length: 81 },
      (_, i) => ({
        eventId: `${i}`,
        occurredAt: new Date(Date.UTC(2030, 0, 1, 0, i)).toISOString(),
        action: "observed",
        outcome: "recorded",
        entity: { kind: "subject", id: "s" }
      })
    );
    const bounded = boundedCustomerJourneyAudit(events);
    expect(bounded.windowed).toBe(true);
    expect(bounded.events).toHaveLength(80);
    expect(bounded.events[0]!.eventId).toBe("1");
    expect(bounded.events.at(-1)!.eventId).toBe("80");
    const projected = projectCustomer360Snapshot(
      {
        ...input(),
        recoveryAudit: events.map(value => ({ id: value.eventId, occurred_at: value.occurredAt, case_id: "c", outcome: "issued" }))
      },
      policy
    );
    expect(projected.lookup.warnings).toContain("evidence_window_limited:customer_360_audit_trail");

  }
);

it("delegates ambiguous lookup without manufacturing freshness", async () => {
    const journey = {
      searchCustomerJourney: vi.fn(async () => ({ candidates: ["a", "b"] })),
      getCustomerJourney: vi.fn(async () => null)
    };
    const facade = createCustomer360ReadFacade({
      authorize: async () => true,
      journey,
      summary: { getPortableSummary: async () => null },
      diagnostics: { history: async () => null }
    });
    const request = { query: "ambiguous", pageSize: 10 };
    expect(await facade.getCustomerJourney(request)).toBeNull();
    expect(journey.getCustomerJourney).toHaveBeenCalledExactlyOnceWith(request);
    expect(await facade.searchCustomerJourney(request)).toEqual({ candidates: ["a", "b"] });
});
it.each(["search", "snapshot", "summary", "diagnostics"] as const)(
  "authorizes %s before source IO and preserves admitted forwarding", async method => {
    const trace: string[] = [];
    let admitted = false;
    const authorize = vi.fn(async () => { trace.push("authorize"); return admitted; });
    const result = { candidates: ["a", "b"] }, failure = new Error("source_refusal");
    const journey = {
      searchCustomerJourney: vi.fn(async function (this: unknown) { trace.push("search"); expect(this).toBe(journey); return result; }),
      getCustomerJourney: vi.fn(async () => { trace.push("snapshot"); return null; })
    };
    const summary = { getPortableSummary: vi.fn(async (_request: { page: number }) => { trace.push("summary"); return result; }) };
    const diagnostics = { history: vi.fn(async (_request: { cursor: string }) => { trace.push("diagnostics"); throw failure; }) };
    const facade = createCustomer360ReadFacade({ authorize, journey, summary, diagnostics });
    const lookup = { query: "ambiguous", pageSize: 7 }, page = { page: 3 }, segment = { cursor: "next" };
    const requests = {
      search: () => facade.searchCustomerJourney(lookup), snapshot: () => facade.getCustomerJourney(lookup),
      summary: () => facade.getPortableSummary(page), diagnostics: () => facade.history(segment)
    };
    expect(await requests[method]()).toEqual({ kind: "denied" });
    const sources = { search: journey.searchCustomerJourney, snapshot: journey.getCustomerJourney,
      summary: summary.getPortableSummary, diagnostics: diagnostics.history };
    for (const source of Object.values(sources)) expect(source).not.toHaveBeenCalled();
    expect(trace).toEqual(["authorize"]);
    trace.length = 0;
    admitted = true;
    if (method === "diagnostics") await expect(requests[method]()).rejects.toBe(failure);
    else expect(await requests[method]()).toBe(method === "snapshot" ? null : result);
    expect(sources[method]).toHaveBeenCalledExactlyOnceWith(method === "summary" ? page : method === "diagnostics" ? segment : lookup);
    expect(trace).toEqual(["authorize", method]);
    expect(authorize).toHaveBeenCalledTimes(2);
  }
);

it.each([
  { name: "closed case", patch: { cases: [{ id: "c", client_id: "owner", order_id: "o", status: "closed" }] }, status: "available", action: false },
  { name: "non-customer", patch: { subject: { ...input().subject, lifecycleStage: "lead" as const } }, status: "available", action: false },
  { name: "non-pending order", patch: { orderTruth: [{ id: "o", client_id: "owner", status: "paid" }] }, status: "unavailable", action: false },
  { name: "different order", patch: { orderTruth: [{ id: "other", client_id: "owner", status: "pending_payment" }] }, status: "unavailable", action: false },
  { name: "expired token", patch: { tokens: [{ case_id: "c", expires_at: "2030-01-01T00:00:00Z" }] }, status: "unavailable", action: true },
  { name: "used token", patch: { tokens: [{ case_id: "c", expires_at: "2031-01-01", used_at: "2030-01-01" }] }, status: "unavailable", action: true },
  { name: "revoked token", patch: { tokens: [{ case_id: "c", expires_at: "2031-01-01", revoked_at: "2030-01-01" }] }, status: "unavailable", action: true },
  { name: "invalid token date", patch: { tokens: [{ case_id: "c", expires_at: "bad-date" }] }, status: "unavailable", action: true },
  { name: "foreign token", patch: { tokens: [{ case_id: "other", expires_at: "2031-01-01" }] }, status: "unavailable", action: true }
])("sweeps recovery eligibility: $name", ({ patch, status, action }) => {
  const result = projectCustomer360Snapshot({ ...input(), orderTruth: [{ id: "o", client_id: "owner", status: "pending_payment" }], ...patch }, policy);
  expect(result.recovery[0]).toMatchObject({ status, actionAvailable: action, lastIssuedAt: null, lastDeliveryStatus: null });
  expect(result.dunningCases[0]?.recoveryAvailable).toBe(action);
});
it.each([
  { name: "intent status", intent: { orderId: "o", status: " paid ", updatedAt: "2030-01-01" }, fallback: "failed", expected: "paid", recoverable: true },
  { name: "legacy payment fallback", intent: { orderId: "other", status: "paid" }, fallback: "failed", expected: "failed", recoverable: true },
  { name: "unknown payment fallback", intent: {}, fallback: null, expected: "unknown", recoverable: false }
])("sweeps legacy projection: $name", ({ intent, fallback, expected, recoverable }) => {
  const result = projectCustomer360Snapshot({ ...input(), subject: { ...input().subject, phone: "123", lastActivityAt: "2029-01-01" },
    legacy: { ...legacy, customer: { authUserLinked: true }, lookup: { warnings: ["host", "host"] },
      orders: [{ orderId: "o", orderNumber: "CAPTURED", status: null,
        omsProjection: { subscriptionId: " sub ", totalMinor: 12, currency: " EUR ", createdAt: "2030-01-01" } }],
      subscriptions: [{ subscriptionId: "sub", status: "active", nextCycleAt: "2031-01-01", templateVersion: 2,
        paymentMethodStatus: " usable ", renewalOrders: [{ orderId: " newest " }, { orderId: "older" }] }],
      payment: { status: fallback, intents: [intent] }, timeline: [{ updated_at: "2030-01-02", created_at: "2032-01-01" }] },
    orderTruth: [{ id: "o", client_id: "owner", status: recoverable ? "pending_payment" : "paid" }],
    contactHealth: { lastTerminalStatus: "delivered", lastTerminalAt: "2030-01-01", reachable: true }, signedIn: true,
    profile: { extension: { value: "complete" }, partial: false }
  }, { ...policy, timelineAudit: () => [{ eventId: "host-event", occurredAt: "2030-01-01", action: "host", outcome: "observed", entity: { kind: "subject", id: "s" } }] });
  expect(result.orders).toEqual([{ orderId: "o", orderNumber: "CAPTURED", status: "unknown", subscriptionId: "sub", totalMinor: 12, currency: "EUR", createdAt: "2030-01-01" }]);
  expect(result.payment).toEqual([{ orderId: "o", status: expected, recoverable, amountMinor: 12, currency: "EUR", lastAttemptAt: intent.updatedAt ?? null }]);
  expect(result.subscriptions[0]).toEqual({ subscriptionId: "sub", status: "active", nextCycleAt: "2031-01-01", latestOrderId: "newest", templateVersion: 2, paymentMethodStatus: "usable" });
  expect(result.subject).toMatchObject({ phone: "123", authUserLinked: true, hasSignedIn: true, lastActivityAt: "2030-01-02" });
  expect(result.contactHealth?.reachable).toBe(true);
  expect(result.extension).toEqual({ value: "complete" });
  expect(result.lookup.warnings).toEqual(["host"]);
  expect(result.auditTrail).toEqual([{ eventId: "host-event", occurredAt: "2030-01-01", action: "host", outcome: "observed", entity: { kind: "subject", id: "s" } }]);
});
it.each([
  { name: "missing money", projection: {}, expected: { subscriptionId: null, totalMinor: null, currency: null, createdAt: null } },
  { name: "invalid money and date", projection: { subscriptionId: " ", totalMinor: -1, currency: 1, createdAt: "invalid" }, expected: { subscriptionId: null, totalMinor: null, currency: null, createdAt: null } },
  { name: "fractional money", projection: { totalMinor: 1.5 }, expected: { subscriptionId: null, totalMinor: null, currency: null, createdAt: null } }
])("sweeps unknown order evidence: $name", ({ projection, expected }) => {
  const result = projectCustomer360Snapshot({ ...input(), legacy: { ...legacy,
    orders: [{ orderId: "o", orderNumber: null, status: "paid", omsProjection: projection }] } }, policy);
  expect(result.orders[0]).toEqual({ orderId: "o", orderNumber: null, status: "paid", ...expected });
  expect(result.subscriptions[0]).toEqual({ subscriptionId: "sub", status: "unknown", nextCycleAt: null, latestOrderId: null, paymentMethodStatus: null });
});
it.each([
  { name: "latest customer notices", notices: [
    { id: "a", case_id: "c", recipient_kind: "customer", notification_kind: "payment_recovery", created_at: "2030-01-01", status: "older" },
    { id: "b", case_id: "c", recipient_kind: "customer", notification_kind: "payment_recovery", created_at: "2030-01-01", status: "recovery" },
    { id: "c", case_id: "c", recipient_kind: "customer", notification_kind: "other", created_at: "2030-01-02", status: "latest" },
    { id: "d", case_id: "c", recipient_kind: "operator", notification_kind: "payment_recovery", created_at: "2030-01-03", status: "private" },
    { id: "e", case_id: "foreign", recipient_kind: "customer", notification_kind: "payment_recovery", created_at: "2030-01-04", status: "foreign" }
  ], notification: "latest", delivery: "recovery" },
  { name: "no customer notices", notices: [], notification: null, delivery: null }
])("sweeps notice selection: $name", ({ notices, notification, delivery }) => {
  const result = projectCustomer360Snapshot({ ...input(), notices,
    cases: [{ id: "c", subscription_id: "sub", client_id: "owner", order_id: "o", status: null, retry_attempt: notices.length ? 2 : -1, next_retry_at: notices.length ? "2031-01-01" : "invalid", updatedAt: "2030-01-03" }],
    tokens: [{ case_id: "c", created_at: "2030-01-02" }, { case_id: "c", created_at: "invalid" }, { case_id: "c", created_at: "2030-01-01" }]
  }, policy);
  expect(result.dunningCases[0]).toMatchObject({ status: "unknown", retryAttempt: notices.length ? 2 : 0, nextRetryAt: notices.length ? "2031-01-01" : null, notificationStatus: notification });
  expect(result.recovery[0]).toMatchObject({ lastIssuedAt: "2030-01-02", lastDeliveryStatus: delivery });
  expect(result.subject.lastActivityAt).toBe("2030-01-03");
});
it.each([
  { name: "valid audit", row: { id: "e", occurred_at: "2030-01-01", case_id: "c", outcome: "issued" }, outcome: "issued" },
  { name: "refused audit", row: { id: "e", occurred_at: "2030-01-01", case_id: "c", outcome: "refused", refusal_code: "expired" }, outcome: "refused:expired" },
  { name: "missing event identity", row: { occurred_at: "2030-01-01", case_id: "c", outcome: "issued" }, outcome: null },
  { name: "missing case identity", row: { id: "e", occurred_at: "2030-01-01", outcome: "issued" }, outcome: null },
  { name: "missing outcome", row: { id: "e", occurred_at: "2030-01-01", case_id: "c" }, outcome: null },
  { name: "invalid audit date", row: { id: "e", occurred_at: "invalid", case_id: "c", outcome: "issued" }, outcome: null }
])("sweeps recovery audit: $name", ({ row, outcome }) => {
  const result = projectCustomer360Snapshot({ ...input(), recoveryAudit: [row] }, policy);
  expect(result.auditTrail).toEqual(outcome ? [{ eventId: "e", occurredAt: "2030-01-01", action: "recovery.issue", outcome, entity: { kind: "dunning_case", id: "c" } }] : []);
});
it.each([79, 80])("sweeps recovery audit source bound: %i", count => {
  const result = projectCustomer360Snapshot({ ...input(), recoveryAudit: Array.from({ length: count }, () => ({})) }, policy);
  expect(result.lookup.warnings).toEqual(count === 80 ? ["evidence_window_limited:customer_recovery_audit"] : []);
});
it.each([
  { name: "same-time identity ordering", times: ["2030-01-01", "2030-01-01"], expected: ["a", "b"] },
  { name: "invalid instant sorts as epoch", times: ["2030-01-01", "invalid"], expected: ["z", "b"] }
])("sweeps audit ordering: $name", ({ times, expected }) => {
  const result = boundedCustomerJourneyAudit((times[0] === times[1] ? Array.from({ length: 81 }, (_, i) => String(80 - i).padStart(2, "0")) : ["b", "z"]).map((eventId, index) => ({ eventId, occurredAt: times[index % 2]!, action: "observed", outcome: "recorded", entity: { kind: "subject", id: "s" } })));
  expect(result.events.map(value => value.eventId)).toEqual(times[0] === times[1] ? Array.from({ length: 80 }, (_, i) => String(i).padStart(2, "0")) : expected);
  expect(result.windowed).toBe(times[0] === times[1]);
});
it.each([
  { name: "delivered", deliveries: [{ status: "delivered", occurredAt: "2030-01-01", permanentBounce: null }], expected: { lastTerminalStatus: "delivered", lastTerminalAt: "2030-01-01", reachable: true } },
  { name: "unknown bounce permanence", deliveries: [{ status: "bounced", occurredAt: "2030-01-01", permanentBounce: null }], expected: { lastTerminalStatus: "bounced", lastTerminalAt: "2030-01-01", reachable: false } },
  { name: "permanent bounce", deliveries: [{ status: "bounced", occurredAt: "2030-01-01", permanentBounce: true }], expected: { lastTerminalStatus: "bounced", lastTerminalAt: "2030-01-01", reachable: false } },
  { name: "undated terminal", deliveries: [{ status: "failed", occurredAt: null, permanentBounce: null }], expected: { lastTerminalStatus: null, lastTerminalAt: null, reachable: true } },
  { name: "lexical newest", deliveries: [{ status: "failed", occurredAt: "2030-01-01T10:00:00+02:00", permanentBounce: null }, { status: "delivered", occurredAt: "2030-01-01T09:00:00Z", permanentBounce: null }], expected: { lastTerminalStatus: "failed", lastTerminalAt: "2030-01-01T10:00:00+02:00", reachable: false } },
  { name: "first equal instant wins", deliveries: [{ status: "complained", occurredAt: "2030-01-01", permanentBounce: null }, { status: "delivered", occurredAt: "2030-01-01", permanentBounce: null }], expected: { lastTerminalStatus: "complained", lastTerminalAt: "2030-01-01", reachable: false } }
])("sweeps contact evidence: $name", ({ deliveries, expected }) => expect(deriveContactHealth(deliveries)).toEqual(expected));
it.each([
  { name: "updated snake", row: { updated_at: "2030-01-02", created_at: "2031-01-01" }, expected: "2030-01-02" },
  { name: "updated camel", row: { updatedAt: "2030-01-02", created_at: "2031-01-01" }, expected: "2030-01-02" },
  { name: "created snake", row: { created_at: "2030-01-02", occurred_at: "2031-01-01" }, expected: "2030-01-02" },
  { name: "created camel", row: { createdAt: "2030-01-02", occurred_at: "2031-01-01" }, expected: "2030-01-02" },
  { name: "occurred snake", row: { occurred_at: "2030-01-02", occurredAt: "2031-01-01" }, expected: "2030-01-02" },
  { name: "occurred camel", row: { occurredAt: "2030-01-02" }, expected: "2030-01-02" },
  { name: "subject fallback", row: { updated_at: "invalid" }, expected: "2029-01-01" }
])("sweeps activity date precedence: $name", ({ name, row, expected }) => {
  const result = projectCustomer360Snapshot({ ...input(), subject: { ...input().subject, lastActivityAt: "2029-01-01" },
    cases: name === "subject fallback" ? [row] : [row, { created_at: "2028-01-01" }] }, policy);
  expect(result.subject.lastActivityAt).toBe(expected);
});
it.each(["undated notice"])("sweeps absent notice timestamp: %s", () => {
  const result = projectCustomer360Snapshot({ ...input(), notices: [
    { case_id: "c", recipient_kind: "customer", status: "undated" },
    { id: "dated", case_id: "c", recipient_kind: "customer", created_at: "2030-01-01", status: "dated" }
  ] }, policy);
  expect(result.dunningCases[0]?.notificationStatus).toBe("dated");
});
