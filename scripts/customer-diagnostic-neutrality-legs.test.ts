import { describe, expect, it } from "vitest";

import {
  BROWSER_DENIED_FUNCTIONS,
  LEDGER_REFUSAL_SQL,
  BROWSER_DENIED_TABLES,
  BROWSER_ROLES,
  NEUTRALITY_LEG_COUNT,
  NEUTRALITY_LEG_NAMES,
  isPrivilegeDenial,
  nullCall,
  runNeutralityLegs,
  type NeutralityContext,
} from "./customer-diagnostic-neutrality-legs.ts";

describe("customer diagnostic neutrality legs", () => {
  it("pins the thirteen legs and their order", () => {
    expect(NEUTRALITY_LEG_COUNT).toBe(13);
    expect(NEUTRALITY_LEG_NAMES).toEqual([
      "ingest", "search", "segment", "overview", "prune", "default-off", "strict-origin",
      "browser-role-denial", "active-operator-audit", "retention-14-day",
      "admission-window-two-minute", "node-scheduler-drive", "ledger-evidence",
    ]);
  });

  it("probes both browser roles against all four relations and all four routines", () => {
    expect([...BROWSER_ROLES]).toEqual(["anon", "authenticated"]);
    expect([...BROWSER_DENIED_TABLES]).toEqual([
      "customer_diagnostic_segments", "customer_diagnostic_events",
      "customer_diagnostic_ingress_attempts", "customer_diagnostic_access_events",
    ]);
    expect(BROWSER_DENIED_FUNCTIONS.map((signature) => signature.slice(0, signature.indexOf("(")))).toEqual([
      "customer_diagnostic_ingest_v1", "customer_diagnostic_search_v1",
      "customer_diagnostic_segment_v1", "customer_diagnostic_prune_v1",
    ]);
  });

  it("renders a typed NULL for every declared argument so the probe never reaches a body", () => {
    expect(nullCall("customer_diagnostic_prune_v1(integer)")).toBe("customer_diagnostic_prune_v1(NULL::integer)");
    expect(nullCall("customer_diagnostic_segment_v1(uuid,uuid,integer,text,integer)"))
      .toBe("customer_diagnostic_segment_v1(NULL::uuid,NULL::uuid,NULL::integer,NULL::text,NULL::integer)");
    for (const signature of BROWSER_DENIED_FUNCTIONS) {
      const rendered = nullCall(signature);
      expect(rendered.split(",").length).toBe(signature.split(",").length);
      expect(rendered).not.toMatch(/\(\s*\)/);
      expect(rendered.slice(rendered.indexOf("(") + 1, -1).split(",").every((arg) => arg.startsWith("NULL::"))).toBe(true);
    }
  });
});

// This is the regression the live falsifier found twice: a granted EXECUTE left leg 8 green because
// the routine's own refusal, and then its revoked helper's refusal, both arrive as SQLSTATE 42501.
describe("privilege denial discrimination", () => {
  const denial = (message: string) => Object.assign(new Error(message), { code: "42501" });

  it("accepts only a denial that names the probed object", () => {
    expect(isPrivilegeDenial(denial("permission denied for function customer_diagnostic_search_v1"),
      "customer_diagnostic_search_v1")).toBe(true);
    expect(isPrivilegeDenial(denial("permission denied for table customer_diagnostic_events"),
      "customer_diagnostic_events")).toBe(true);
  });

  it("rejects the routine's own 42501 refusal, which an EXECUTABLE routine raises", () => {
    expect(isPrivilegeDenial(denial("communications_operator_inactive"),
      "customer_diagnostic_search_v1")).toBe(false);
  });

  it("rejects a denial raised by a different object inside a routine the role CAN execute", () => {
    expect(isPrivilegeDenial(denial("permission denied for function communications_require_active_operator"),
      "customer_diagnostic_search_v1")).toBe(false);
  });

  it("rejects a non-privilege SQLSTATE and a missing error", () => {
    expect(isPrivilegeDenial(Object.assign(new Error("permission denied for function customer_diagnostic_prune_v1"),
      { code: "22023" }), "customer_diagnostic_prune_v1")).toBe(false);
    expect(isPrivilegeDenial(undefined, "customer_diagnostic_prune_v1")).toBe(false);
  });
});

// M1: `platform_claim_job_run` writes a refusal to the `error` column and merges only
// activeDriver/leaseOwner into metadata, so the old `metadata->>'reason'` count could never be
// non-zero - an anti-masking check that was silently vacuous.
describe("leg 13 anti-masking count", () => {
  it("counts refusals on the error column the portable ledger actually writes", () => {
    expect(LEDGER_REFUSAL_SQL).toContain("FROM public.platform_job_runs");
    expect(LEDGER_REFUSAL_SQL).toContain("error = 'inactive_driver'");
    expect(LEDGER_REFUSAL_SQL).toContain("job_name = $1");
  });

  it("never reads the refusal out of metadata, where it is never written", () => {
    expect(LEDGER_REFUSAL_SQL).not.toContain("metadata");
    expect(LEDGER_REFUSAL_SQL).not.toContain("reason");
  });
});

describe("neutrality leg runner", () => {
  it("records every leg as a failure when the database cannot be reached, and never as a pass", async () => {
    const context: NeutralityContext = {
      env: {},
      query: () => Promise.reject(Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" })),
      operatorId: "00000000-0000-4000-8000-000000000000",
    };
    const outcomes = await runNeutralityLegs(context);
    expect(outcomes).toHaveLength(NEUTRALITY_LEG_COUNT);
    expect(outcomes.map((leg) => leg.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(outcomes.every((leg) => leg.status === "fail")).toBe(true);
    expect(outcomes.every((leg) => leg.detail.length > 0)).toBe(true);
  });
});
