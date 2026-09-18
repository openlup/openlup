import { describe, expect, it, vi } from "vitest";
import {
  absorbOperatorLead,
  applyOperatorSubscriptionAction,
  correctOperatorSubjectEmail,
  getCustomer360Snapshot,
} from "./customer360Client";
import type { OperatorLeadAbsorptionRequest } from "./customerSubjectCorrectionContracts";
import type {
  OperatorEmailCorrectionRequest,
  OperatorSubscriptionActionRequest,
} from "./customerSupportCommandContracts";

const SUBJECT_ID = "10000000-0000-4000-8000-000000000001";

function snapshotBody(extra: Record<string, unknown> = {}) {
  return {
    contractVersion: "support.customer_360.v2",
    lookup: { query: SUBJECT_ID, matchedBy: "subject_id", confidence: "exact", warnings: [] },
    subject: {
      subjectId: SUBJECT_ID,
      displayName: "Ada Example",
      email: "ada@example.test",
      lifecycleStage: "customer",
      lifecycle: [],
      firstSeenAt: null,
      lastActivityAt: null,
    },
    orders: [], subscriptions: [], payment: [], dunningCases: [], recovery: [], auditTrail: [],
    ...extra,
  };
}

function fetcherReturning(body: unknown) {
  return vi.fn().mockResolvedValue({
    status: 200,
    json: () => Promise.resolve({ ok: true, data: body }),
  });
}

describe("getCustomer360Snapshot", () => {
  it("requests the snapshot by subject and omits the search mode", async () => {
    const fetcher = fetcherReturning(snapshotBody());

    await getCustomer360Snapshot("access-token", SUBJECT_ID, { fetcher });

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer access-token");
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("subjectId")).toBe(SUBJECT_ID);
    expect(params.has("mode")).toBe(false);
  });

  it("accepts a snapshot that carries contact health and the sign-in link", async () => {
    const fetcher = fetcherReturning(snapshotBody({
      contactHealth: {
        lastTerminalStatus: "bounced",
        lastTerminalAt: "2026-08-14T10:00:00.000Z",
        reachable: false,
      },
    }));

    const result = await getCustomer360Snapshot("access-token", SUBJECT_ID, { fetcher });
    expect(result.contactHealth).toMatchObject({ lastTerminalStatus: "bounced", reachable: false });
  });

  it("accepts a snapshot from a deployment that cannot report contact health", async () => {
    const fetcher = fetcherReturning(snapshotBody());
    const result = await getCustomer360Snapshot("access-token", SUBJECT_ID, { fetcher });
    expect(result.contactHealth).toBeUndefined();
  });

  it("rejects an unknown contact-health status rather than rendering it", async () => {
    const fetcher = fetcherReturning(snapshotBody({
      contactHealth: { lastTerminalStatus: "exploded", lastTerminalAt: null, reachable: false },
    }));

    await expect(getCustomer360Snapshot("access-token", SUBJECT_ID, { fetcher })).rejects.toThrow();
  });
});

const SUBSCRIPTION_ID = "20000000-0000-4000-8000-000000000002";
const SUBSCRIPTION_COMMAND: OperatorSubscriptionActionRequest = {
  action: "apply_subscription_action",
  subscriptionId: SUBSCRIPTION_ID,
  subscriptionAction: "slide_next_cycle",
  expectedVersion: 4,
  idempotencyKey: "operator-idem-slide-1",
  payload: { newNextCycleAt: "2026-09-01T10:00:00.000Z", slideMinDays: 1 },
};
const EMAIL_COMMAND: OperatorEmailCorrectionRequest = {
  action: "correct_email",
  subjectId: SUBJECT_ID,
  expectedEmail: "typo@example.test",
  newEmail: "fixed@example.test",
  idempotencyKey: "operator-idem-email-1",
};

function settledSlide(extra: Record<string, unknown> = {}) {
  return {
    contractVersion: "support.customer_360.v2",
    action: "apply_subscription_action",
    subscriptionAction: "slide_next_cycle",
    subscriptionId: SUBSCRIPTION_ID,
    outcome: "applied",
    subscriptionStatus: "active",
    nextCycleAt: "2026-09-01T10:00:00.000Z",
    templateVersion: 4,
    eventId: "30000000-0000-4000-8000-000000000003",
    appliedBy: "operator_reschedule_band",
    ...extra,
  };
}

describe("applyOperatorSubscriptionAction", () => {
  it("posts the command to the journey route with the operator's bearer token", async () => {
    const fetcher = fetcherReturning(settledSlide());

    const result = await applyOperatorSubscriptionAction(
      "access-token", SUBSCRIPTION_COMMAND, { fetcher },
    );

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/bff/admin/support/customer-journey");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer access-token");
    // The subscriber's own identity is never sent: the authority derives it.
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent).toEqual(SUBSCRIPTION_COMMAND);
    expect(Object.keys(sent)).not.toContain("authUserId");
    expect(result.outcome).toBe("applied");
  });

  it("resolves a named business refusal instead of rejecting", async () => {
    const fetcher = fetcherReturning({
      contractVersion: "support.customer_360.v2",
      action: "apply_subscription_action",
      subscriptionAction: "resume",
      subscriptionId: SUBSCRIPTION_ID,
      outcome: "refused",
      refusalCode: "subject_account_unlinked",
    });

    const result = await applyOperatorSubscriptionAction(
      "access-token", { ...SUBSCRIPTION_COMMAND, subscriptionAction: "resume" }, { fetcher },
    );
    expect(result).toMatchObject({ outcome: "refused", refusalCode: "subject_account_unlinked" });
  });

  it("accepts a settled command that wrote no event", async () => {
    const fetcher = fetcherReturning(settledSlide({ outcome: "noop", eventId: null, appliedBy: null }));
    const result = await applyOperatorSubscriptionAction("access-token", SUBSCRIPTION_COMMAND, { fetcher });
    expect(result).toMatchObject({ outcome: "noop", eventId: null, appliedBy: null });
  });

  it("rejects an unknown refusal code rather than rendering it", async () => {
    const fetcher = fetcherReturning(settledSlide({ outcome: "refused", refusalCode: "made_up" }));
    await expect(applyOperatorSubscriptionAction("access-token", SUBSCRIPTION_COMMAND, { fetcher }))
      .rejects.toThrow();
  });

  it("rejects a settled response that carries a subscriber address it should not have", async () => {
    const fetcher = fetcherReturning(settledSlide({ email: "leaked@example.test" }));
    await expect(applyOperatorSubscriptionAction("access-token", SUBSCRIPTION_COMMAND, { fetcher }))
      .rejects.toThrow();
  });
});

describe("correctOperatorSubjectEmail", () => {
  it("posts the correction and returns the unlinked precondition it relied on", async () => {
    const fetcher = fetcherReturning({
      contractVersion: "support.customer_360.v2",
      action: "correct_email",
      subjectId: SUBJECT_ID,
      outcome: "applied",
      authUserLinked: false,
    });

    const result = await correctOperatorSubjectEmail("access-token", EMAIL_COMMAND, { fetcher });

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/bff/admin/support/customer-journey");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(EMAIL_COMMAND);
    expect(result).toMatchObject({ outcome: "applied", authUserLinked: false });
  });

  it("resolves a linked-account refusal instead of rejecting", async () => {
    const fetcher = fetcherReturning({
      contractVersion: "support.customer_360.v2",
      action: "correct_email",
      subjectId: SUBJECT_ID,
      outcome: "refused",
      refusalCode: "subject_account_linked",
      holderId: null,
    });
    const result = await correctOperatorSubjectEmail("access-token", EMAIL_COMMAND, { fetcher });
    expect(result).toMatchObject({ outcome: "refused", refusalCode: "subject_account_linked", holderId: null });
  });

  it("rejects a response that echoes a stored address back to the console", async () => {
    const fetcher = fetcherReturning({
      contractVersion: "support.customer_360.v2",
      action: "correct_email",
      subjectId: SUBJECT_ID,
      outcome: "conflict",
      refusalCode: "email_expectation_conflict",
      currentEmail: "secret-real-address@example.test",
    });
    await expect(correctOperatorSubjectEmail("access-token", EMAIL_COMMAND, { fetcher }))
      .rejects.toThrow();
  });
});

const ABSORB_COMMAND: OperatorLeadAbsorptionRequest = {
  action: "absorb_lead",
  subjectId: SUBJECT_ID,
  leadId: "20000000-0000-4000-8000-000000000002",
  expectedLeadEmail: "held@example.test",
  idempotencyKey: "admin-support:absorb:1",
};
const CARRIED = { personalization: 1, consents: 2, sourceLinks: 1, deliveries: 4 };

describe("absorbOperatorLead", () => {
  it("posts every argument the command names and returns what was carried", async () => {
    const fetcher = fetcherReturning({
      contractVersion: "support.customer_360.v2", action: "absorb_lead",
      subjectId: SUBJECT_ID, leadId: ABSORB_COMMAND.leadId, outcome: "applied", carried: CARRIED,
    });

    const result = await absorbOperatorLead("access-token", ABSORB_COMMAND, { fetcher });

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/bff/admin/support/customer-journey");
    expect(init.method).toBe("POST");
    // The whole body, not a subset: an argument that never left the browser is the
    // same defect as one that vanished on the way into the routine.
    expect(JSON.parse(String(init.body))).toEqual(ABSORB_COMMAND);
    expect(result).toMatchObject({ outcome: "applied", carried: CARRIED });
  });

  it("resolves a named refusal, blockers included, instead of rejecting", async () => {
    const fetcher = fetcherReturning({
      contractVersion: "support.customer_360.v2", action: "absorb_lead",
      subjectId: SUBJECT_ID, leadId: ABSORB_COMMAND.leadId, outcome: "refused",
      refusalCode: "lead_has_commercial_footprint", blockingTables: ["commerce_orders"],
    });
    await expect(absorbOperatorLead("access-token", ABSORB_COMMAND, { fetcher })).resolves.toMatchObject({
      outcome: "refused", refusalCode: "lead_has_commercial_footprint", blockingTables: ["commerce_orders"],
    });
  });

  it("rejects a refusal code nobody has modelled rather than rendering it raw", async () => {
    const fetcher = fetcherReturning({
      contractVersion: "support.customer_360.v2", action: "absorb_lead",
      subjectId: SUBJECT_ID, leadId: ABSORB_COMMAND.leadId, outcome: "refused",
      refusalCode: "lead_smells_wrong", blockingTables: [],
    });
    await expect(absorbOperatorLead("access-token", ABSORB_COMMAND, { fetcher })).rejects.toThrow();
  });

  // Absorption reports counts, never the absorbed record's own data. A response that
  // smuggled the address back would put a second person's value on this customer's card.
  it("rejects a settled response carrying the absorbed record's address", async () => {
    const fetcher = fetcherReturning({
      contractVersion: "support.customer_360.v2", action: "absorb_lead",
      subjectId: SUBJECT_ID, leadId: ABSORB_COMMAND.leadId, outcome: "applied",
      carried: CARRIED, leadEmail: "held@example.test",
    });
    await expect(absorbOperatorLead("access-token", ABSORB_COMMAND, { fetcher })).rejects.toThrow();
  });
});
