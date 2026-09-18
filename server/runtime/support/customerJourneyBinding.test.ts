import { describe, expect, it, vi } from "vitest";
import type {
  CloseableCustomerSupportJourneyPort,
  CustomerSupportJourneyPort,
} from "../../adapters/postgres/customerSupportJourney.js";
import {
  CustomerSupportAgentReadDisabledError,
  type CustomerSupportJourneyActor,
  resolveCustomerSupportJourneyBinding,
  type ManagedCustomerSupportJourneyScope,
} from "./customerJourneyBinding.js";
const DIRECT = {
  PLATFORM_BUNDLE: "node-postgres",
  DATABASE_URL: "postgres://platform",
};
function port(close = vi.fn(async () => {})): CloseableCustomerSupportJourneyPort {
  return {
    getPortableSummary: vi.fn(),
    searchPortableClients: vi.fn(),
    getPortableClientDetail: vi.fn(),
    searchCustomerJourney: vi.fn(),
    getCustomerJourney: vi.fn(),
    issueRecovery: vi.fn(async () => ({
      outcome: "refused" as const,
      refusalCode: "case_not_open" as const,
    })),
    applySubscriptionAction: vi.fn(async () => ({
      outcome: "refused" as const,
      refusalCode: "slide_not_available" as const,
    })),
    correctSubjectEmail: vi.fn(async () => ({
      outcome: "refused" as const,
      refusalCode: "subject_account_linked" as const,
    })),
    correctSubjectPhone: vi.fn(async () => ({
      outcome: "refused" as const,
      refusalCode: "phone_expectation_conflict" as const,
    })),
    absorbLead: vi.fn(async () => ({
      outcome: "refused" as const,
      leadId: "0c1e0000-0000-4000-8000-000000000001",
      refusalCode: "lead_not_found" as const,
      blockingTables: [] as string[],
    })),
    close,
  };
}
const human = (operatorId: string) => ({ operatorId, isMachineActor: false });
describe("customer support journey binding", () => {
  it("refuses a direct bundle without DATABASE_URL before constructing the adapter", () => {
    const createPostgresPort = vi.fn();
    expect(resolveCustomerSupportJourneyBinding(
      { PLATFORM_BUNDLE: "node-postgres" },
      { createPostgresPort },
    )).toEqual({ error: "database_url_required" });
    expect(createPostgresPort).not.toHaveBeenCalled();
  });
  it("constructs an operator-scoped direct capability without Supabase environment", async () => {
    const close = vi.fn(async () => {});
    const direct = port(close);
    const createPostgresPort = vi.fn(() => direct);
    const resolved = resolveCustomerSupportJourneyBinding(DIRECT, { createPostgresPort });
    await expect(resolved.binding!.run(human("operator-1"), async (bound) => {
      expect(bound.issueRecovery).toBeTypeOf("function");
      return "ok";
    })).resolves.toBe("ok");
    expect(resolved.binding!.identity).toBe("node-postgres");
    expect(createPostgresPort).toHaveBeenCalledWith(
      { connectionString: "postgres://platform", operatorId: "operator-1" },
      { isMachineActor: false },
    );
    expect(close).toHaveBeenCalledOnce();
  });
  it("closes the direct lane after a named refusal", async () => {
    const close = vi.fn(async () => {});
    const direct = port(close);
    const resolved = resolveCustomerSupportJourneyBinding(DIRECT, {
      createPostgresPort: () => direct,
    });
    await expect(resolved.binding!.run(human("operator-1"), (bound) => bound.issueRecovery({
      subjectId: "subject-1",
      caseId: "case-1",
      idempotencyKey: "support-recovery-1",
      operatorId: "operator-1",
    }))).resolves.toEqual({ outcome: "refused", refusalCode: "case_not_open" });
    expect(close).toHaveBeenCalledOnce();
  });
  it("closes the direct lane when work throws", async () => {
    const close = vi.fn(async () => {});
    const resolved = resolveCustomerSupportJourneyBinding(DIRECT, {
      createPostgresPort: () => port(close),
    });
    await expect(resolved.binding!.run(human("operator-1"), async () => {
      throw new Error("route failed");
    })).rejects.toThrow("route failed");
    expect(close).toHaveBeenCalledOnce();
  });
  it("rejects an empty operator before opening a direct lane", async () => {
    const createPostgresPort = vi.fn();
    const resolved = resolveCustomerSupportJourneyBinding(DIRECT, { createPostgresPort });
    await expect(resolved.binding!.run(human(" "), async () => null))
      .rejects.toThrow("customer_support_operator_required");
    expect(createPostgresPort).not.toHaveBeenCalled();
  });
  it("fails closed for managed bundles without an injected capability scope", () => {
    expect(resolveCustomerSupportJourneyBinding({ PLATFORM_BUNDLE: "node-supabase" }))
      .toEqual({ error: "managed_customer_support_scope_required" });
  });
  it("delegates managed execution to the injected scope without reading Supabase env", async () => {
    const managedPort = port();
    const calls: string[] = [];
    const scope: ManagedCustomerSupportJourneyScope = {
      // The identity move is a separate accessor on the scope because it speaks to
      // the auth service rather than the journey authority; a double must still
      // offer it, or the scope type is no longer total.
      identityMove: () => ({
        findLinkedIdentity: async () => null,
        findClientHoldingEmail: async () => null,
        moveIdentityEmail: async () => undefined,
      }),
      async run<T>(actor: CustomerSupportJourneyActor, work: (value: CustomerSupportJourneyPort) => Promise<T>) {
        calls.push(`${actor.operatorId}:${actor.isMachineActor}`);
        return work(managedPort);
      },
    };
    const managedScopeFactory = vi.fn(() => scope);
    const env = { PLATFORM_BUNDLE: "node-supabase", APP_BASE_URL: "http://localhost" };
    const resolved = resolveCustomerSupportJourneyBinding(env, { managedScopeFactory });
    await expect(resolved.binding!.run(human("operator-managed"), async (bound) => bound === managedPort))
      .resolves.toBe(true);
    expect(resolved.binding!.identity).toBe("node-supabase");
    expect(managedScopeFactory).toHaveBeenCalledWith(env);
    expect(calls).toEqual(["operator-managed:false"]);
  });
  it("fails closed when an injected managed factory cannot create its scope", async () => {
    const resolved = resolveCustomerSupportJourneyBinding(
      { PLATFORM_BUNDLE: "vercel-supabase" },
      { managedScopeFactory: () => null },
    );
    await expect(resolved.binding!.run(human("operator-1"), async () => null))
      .rejects.toThrow("managed_customer_support_scope_unavailable");
  });
  it("fails a machine actor closed before constructing a customer data port", async () => {
    const createPostgresPort = vi.fn();
    const resolved = resolveCustomerSupportJourneyBinding(DIRECT, { createPostgresPort });
    await expect(resolved.binding!.run({ operatorId: "agent-1", isMachineActor: true }, async () => null))
      .rejects.toBeInstanceOf(CustomerSupportAgentReadDisabledError);
    expect(createPostgresPort).not.toHaveBeenCalled();
  });
  it("opens the direct audited rail for an enabled machine actor without Supabase governance", async () => {
    const direct = port();
    vi.mocked(direct.searchCustomerJourney).mockResolvedValue({ candidates: [{ email: "ada@example.test" }] } as never);
    const createPostgresPort = vi.fn(() => direct);
    const resolved = resolveCustomerSupportJourneyBinding(DIRECT, { createPostgresPort });
    const result = await resolved.binding!.run({ operatorId: "agent-1", isMachineActor: true, governance: { flagEnabled: true } },
      (bound) => bound.searchCustomerJourney({ query: "ada@example.test", pageSize: 10 }));
    expect(result.candidates[0]?.email).toBeNull();
    expect(createPostgresPort).toHaveBeenCalledWith(expect.anything(), { isMachineActor: true });
  });
});
