import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresCustomerSupportJourneyPort,
  type PostgresCustomerSupportJourneyLane,
} from "./customerSupportJourney.js";
const SUBJECT = {
  subjectId: "subject-1",
  displayName: "Ada Example",
  email: "ada@example.test",
  phone: null,
  lifecycleStage: "customer" as const,
  createdAt: "2026-08-01T00:00:00.000Z",
  lastActivityAt: "2026-08-15T00:00:00.000Z",
};
const SUMMARY = {
  contractVersion: "clients.customer_360.v2" as const,
  summary: {
    totalSubjects: 1,
    byLifecycleStage: { lead: 0, waitlist: 0, tester: 0, customer: 1, inactive: 0 },
    openDunningCases: 1,
    recoverableCases: 1,
    lastActivityAt: "2026-08-15T00:00:00.000Z",
  },
};
const SEARCH = {
  contractVersion: "clients.customer_360.v2" as const,
  candidates: [{
    subject: SUBJECT,
    matchedBy: "email" as const,
    confidence: "exact" as const,
    journeyLookup: { subjectId: SUBJECT.subjectId },
  }],
  totalCount: 1,
  page: 0,
  pageSize: 10,
};
const DETAIL = {
  contractVersion: "clients.customer_360.v2" as const,
  subject: SUBJECT,
  references: {
    orderIds: ["order-1"],
    subscriptionIds: ["subscription-1"],
    dunningCaseIds: ["case-1"],
  },
  journeyLookup: { subjectId: SUBJECT.subjectId },
};
const JOURNEY = {
  contractVersion: "support.customer_360.v2" as const,
  lookup: {
    query: SUBJECT.subjectId,
    matchedBy: "subject_id" as const,
    confidence: "exact" as const,
    warnings: [],
  },
  subject: {
    subjectId: SUBJECT.subjectId,
    displayName: SUBJECT.displayName,
    email: SUBJECT.email,
    lifecycleStage: "customer" as const,
    lifecycle: [{ stage: "customer" as const, enteredAt: SUBJECT.createdAt, exitedAt: null }],
    firstSeenAt: SUBJECT.createdAt,
    lastActivityAt: SUBJECT.lastActivityAt,
  },
  orders: [],
  subscriptions: [],
  payment: [],
  dunningCases: [],
  recovery: [],
  auditTrail: [],
};
function rail(results: unknown[]) {
  const query = vi.fn(async (_sql: string, _values: unknown[]) => ({
    rows: [{ result: results.shift() }],
  }));
  const close = vi.fn(async () => {});
  const lane: PostgresCustomerSupportJourneyLane = {
    run: (work) => work({ query } as never),
    close,
  };
  return { lane, query, close };
}
describe("Postgres customer support journey", () => {
  it("durably audits a direct machine read on the provider-neutral database rail", async () => {
    const pg = rail([SUMMARY]);
    const port = createPostgresCustomerSupportJourneyPort({ connectionString: "postgres://platform", operatorId: "operator-1" }, { createLane: () => pg.lane, isMachineActor: true });
    await port.getPortableSummary({});
    expect(pg.query.mock.calls.slice(1).map(([sql]) => sql)).toEqual([expect.stringContaining("INSERT INTO public.customer_support_read_audit_events")]);
  });
  it("reads summary, search, detail and journey through literal operator-scoped routines", async () => {
    const pg = rail([SUMMARY, SEARCH, DETAIL, JOURNEY]);
    const port = createPostgresCustomerSupportJourneyPort(
      { connectionString: "postgres://platform", operatorId: "operator-1" },
      { createLane: () => pg.lane },
    );
    await expect(port.getPortableSummary({})).resolves.toEqual(SUMMARY);
    await expect(port.searchPortableClients({
      query: "ada@example.test", page: 0, pageSize: 10, lifecycleStage: "all",
    })).resolves.toEqual(SEARCH);
    await expect(port.getPortableClientDetail({ subjectId: SUBJECT.subjectId })).resolves.toEqual(DETAIL);
    await expect(port.getCustomerJourney({ subjectId: SUBJECT.subjectId, pageSize: 10 }))
      .resolves.toEqual(JOURNEY);
    expect(pg.query.mock.calls).toEqual([
      ["SELECT public.customer_support_summary($1) AS result", ["operator-1"]],
      ["SELECT public.customer_support_search($1,$2,$3,$4,$5) AS result", [
        "operator-1", "ada@example.test", 0, 10, "all",
      ]],
      ["SELECT public.customer_support_detail($1,$2) AS result", ["operator-1", SUBJECT.subjectId]],
      ["SELECT public.customer_support_journey($1,$2) AS result", ["operator-1", SUBJECT.subjectId]],
    ]);
  });
  it("projects portable search onto the neutral journey search contract", async () => {
    const pg = rail([SEARCH]);
    const port = createPostgresCustomerSupportJourneyPort(
      { connectionString: "postgres://platform", operatorId: "operator-1" },
      { createLane: () => pg.lane, isMachineActor: true },
    );
    await expect(port.searchCustomerJourney({ query: "ada@example.test", pageSize: 10 }))
      .resolves.toEqual({
        contractVersion: "support.customer_360.v2",
        query: "ada@example.test",
        candidates: [{
          subjectId: SUBJECT.subjectId,
          displayName: SUBJECT.displayName,
          email: SUBJECT.email,
          lifecycleStage: "customer",
          matchedBy: "email",
          confidence: "exact",
          lastActivityAt: SUBJECT.lastActivityAt,
          snapshotLookup: { subjectId: SUBJECT.subjectId },
        }],
        warnings: [],
      });
    expect(pg.query.mock.calls.slice(1).map(([, values]) => values[1])).toEqual(["/api/bff/admin/support/customer-journey"]);
  });
  it("delegates recovery with internal credentials and returns only the sanitized authority result", async () => {
    const pg = rail([{
      outcome: "issued",
      delivery_status: "queued",
      audit_event_id: "audit-1",
      provider_ref: "must-not-escape",
    }]);
    const port = createPostgresCustomerSupportJourneyPort(
      { connectionString: "postgres://platform", operatorId: "operator-1" },
      {
        createLane: () => pg.lane,
        createOpaqueToken: () => "raw-secret-token",
        now: () => Date.parse("2026-08-15T00:00:00.000Z"),
      },
    );
    const result = await port.issueRecovery({
      subjectId: SUBJECT.subjectId,
      caseId: "case-1",
      idempotencyKey: "support-recovery-1",
      operatorId: "operator-1",
    });
    expect(result).toEqual({
      outcome: "issued",
      deliveryStatus: "queued",
      auditEventId: "audit-1",
    });
    expect(JSON.stringify(result)).not.toMatch(/raw-secret-token|provider_ref|token=|recovery_path/);
    const expectedHash = createHash("sha256").update("raw-secret-token").digest("hex");
    const [, values] = pg.query.mock.calls[0]!;
    expect(pg.query.mock.calls[0]![0]).toBe(
      "SELECT public.customer_support_issue_recovery($1,$2,$3,$4,$5,$6,$7,$8) AS result",
    );
    expect(values).toEqual([
      "operator-1",
      SUBJECT.subjectId,
      "case-1",
      "support-recovery-1",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expectedHash,
      "2026-08-16T00:00:00.000Z",
      "/konto/platnosc/napraw?token=raw-secret-token",
    ]);
  });
  it.each([
    [{ outcome: "replayed", deliveryStatus: "queued", auditEventId: "audit-1" }, {
      outcome: "replayed", deliveryStatus: "queued", auditEventId: "audit-1",
    }],
    [{ outcome: "refused", refusalCode: "case_not_open" }, {
      outcome: "refused", refusalCode: "case_not_open",
    }],
    [{ outcome: "conflict" }, {
      outcome: "conflict", conflictCode: "idempotency_conflict",
    }],
  ] as const)("maps replay, refusal and conflict without inventing state", async (database, expected) => {
    const pg = rail([database]);
    const port = createPostgresCustomerSupportJourneyPort(
      { connectionString: "postgres://platform", operatorId: "operator-1" },
      { createLane: () => pg.lane, createOpaqueToken: () => "token" },
    );
    await expect(port.issueRecovery({
      subjectId: SUBJECT.subjectId,
      caseId: "case-1",
      idempotencyKey: "support-recovery-1",
      operatorId: "operator-1",
    })).resolves.toEqual(expected);
  });
  it("turns the database idempotency signal into a sanitized conflict", async () => {
    const query = vi.fn(async (_sql: string, _values: unknown[]) => {
      throw { code: "23505", message: "private provider detail" };
    });
    const lane: PostgresCustomerSupportJourneyLane = {
      run: (work) => work({ query } as never),
      close: vi.fn(async () => {}),
    };
    const port = createPostgresCustomerSupportJourneyPort(
      { connectionString: "postgres://platform", operatorId: "operator-1" },
      { createLane: () => lane, createOpaqueToken: () => "token" },
    );
    await expect(port.issueRecovery({
      subjectId: SUBJECT.subjectId,
      caseId: "case-1",
      idempotencyKey: "support-recovery-1",
      operatorId: "operator-1",
    })).resolves.toEqual({ outcome: "conflict", conflictCode: "idempotency_conflict" });
  });
  it("fails closed on operator-scope mismatch without touching PostgreSQL", async () => {
    const pg = rail([]);
    const port = createPostgresCustomerSupportJourneyPort(
      { connectionString: "postgres://platform", operatorId: "operator-1" },
      { createLane: () => pg.lane },
    );
    await expect(port.issueRecovery({
      subjectId: SUBJECT.subjectId,
      caseId: "case-1",
      idempotencyKey: "support-recovery-1",
      operatorId: "operator-2",
    })).rejects.toThrow("customer_support_operator_scope_mismatch");
    expect(pg.query).not.toHaveBeenCalled();
  });
});

/**
 * The one operator command this lane runs for real.
 *
 * The three neighbours - subscription actions and both contact corrections - answer
 * a named unavailability because the platform migration tree publishes no twin of
 * them. Absorption ships with one, so refusing here would be a lie about a routine
 * this deployment holds, and it would leave a self-hosted operator with no way at
 * all to free an address a marketing lead is squatting on.
 */
describe("absorbing a lead over the public PostgreSQL rail", () => {
  const CUSTOMER = "customer-1";
  const LEAD = "lead-1";
  const CARRIED = { personalization: 1, consents: 2, sourceLinks: 1, deliveries: 4 };
  const absorb = (operatorId = "operator-1") => ({
    customerId: CUSTOMER, leadId: LEAD, expectedLeadEmail: "held@example.test",
    idempotencyKey: "absorb-lead-1", operatorId,
  });
  const failing = (error: unknown) => {
    const query = vi.fn(async () => { throw error; });
    return { query, lane: { run: (work: (e: never) => unknown) => work({ query } as never), close: vi.fn(async () => {}) } };
  };

  it("really absorbs instead of refusing, through the literal operator-scoped routine", async () => {
    const pg = rail([{ outcome: "applied", action: "absorb_lead", leadId: LEAD, customerId: CUSTOMER, carried: CARRIED }]);
    const port = createPostgresCustomerSupportJourneyPort(
      { connectionString: "postgres://platform", operatorId: "operator-1" },
      { createLane: () => pg.lane, now: () => Date.parse("2026-08-18T10:00:00.000Z") },
    );
    await expect(port.absorbLead(absorb())).resolves.toEqual({
      outcome: "applied", leadId: LEAD, customerId: CUSTOMER, carried: CARRIED,
    });
    expect(pg.query.mock.calls[0]?.[0]).toContain("public.customer_support_absorb_lead_v1($1,$2,$3,$4,$5,$6)");
    // Positional rather than named, and in the routine's own order: this is the whole
    // difference between the two lanes, so a silent reorder must fail here.
    expect(pg.query.mock.calls[0]?.[1]).toEqual([
      "operator-1", CUSTOMER, LEAD, "held@example.test", "absorb-lead-1", "2026-08-18T10:00:00.000Z",
    ]);
  });

  it.each([
    "lead_not_found", "customer_not_found", "lead_email_expectation_conflict",
    "lead_has_identity", "lead_has_commercial_footprint", "unclassified_referencing_table",
  ] as const)("reports %s as a refusal an operator can read", async (refusalCode) => {
    const pg = rail([{ outcome: "refused", leadId: LEAD, refusalCode, blockingTables: ["commerce_orders"] }]);
    const port = createPostgresCustomerSupportJourneyPort(
      { connectionString: "postgres://platform", operatorId: "operator-1" },
      { createLane: () => pg.lane },
    );
    await expect(port.absorbLead(absorb())).resolves.toEqual({
      outcome: "refused", leadId: LEAD, refusalCode, blockingTables: ["commerce_orders"],
    });
  });

  it.each([
    [{ code: "42501", message: "private provider detail" }, "managed_customer_support_operator_inactive"],
    [{ code: "22023", message: "customer_support_absorb_lead_invalid" }, "customer_support_operator_command_invalid"],
    [{ code: "23505", message: "private provider detail" }, "customer_support_idempotency_conflict"],
    // The twin migration is absent from this tree. Naming it as an unavailable
    // authority is the honest answer: the command was fine, the routine is missing.
    [{ code: "42883", message: "function ... does not exist" }, "operator_subscription_authority_unavailable"],
    [{ code: "08006", message: "private provider detail" }, "customer_support_lead_absorption_failed"],
  ])("prices the database signal %# without leaking the driver error", async (error, expected) => {
    const pg = failing(error);
    const port = createPostgresCustomerSupportJourneyPort(
      { connectionString: "postgres://platform", operatorId: "operator-1" },
      { createLane: () => pg.lane as never },
    );
    await expect(port.absorbLead(absorb())).rejects.toThrow(expected);
    await expect(port.absorbLead(absorb())).rejects.not.toThrow("private provider detail");
  });

  // The parse is deliberately outside the failure mapping. An answer this lane cannot
  // read is not an upstream fault to be re-priced, and swallowing it would turn an
  // unrecognized routine answer into an operator-inactive refusal.
  it("keeps an unreadable answer an invalid response rather than a refusal", async () => {
    const pg = rail([{ outcome: "applied", leadId: LEAD, customerId: CUSTOMER }]);
    const port = createPostgresCustomerSupportJourneyPort(
      { connectionString: "postgres://platform", operatorId: "operator-1" },
      { createLane: () => pg.lane },
    );
    await expect(port.absorbLead(absorb())).rejects.toThrow("customer_support_lead_absorption_response_invalid");
  });

  it("fails closed on operator-scope mismatch without touching PostgreSQL", async () => {
    const pg = rail([]);
    const port = createPostgresCustomerSupportJourneyPort(
      { connectionString: "postgres://platform", operatorId: "operator-1" },
      { createLane: () => pg.lane },
    );
    await expect(port.absorbLead(absorb("operator-2"))).rejects.toThrow("customer_support_operator_scope_mismatch");
    expect(pg.query).not.toHaveBeenCalled();
  });
});
