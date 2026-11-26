import { describe, expect, it } from "vitest";
import { parseStorefrontVerdict, type StorefrontVerdict } from "../../../src/lifecycle/index.js";
import { runStorefrontScenario, serializeStorefrontVerdict, storefrontScenarios, type StorefrontAdapter, type StorefrontScenario } from "../../../src/storefront/testing/index.js";
import { storeDouble, type StoreDoubleSwitches } from "./storeDouble.js";

type RunOptions = Parameters<typeof runStorefrontScenario>[0];
type Double = ReturnType<typeof storeDouble>;

const commands = { create: { method: "POST", path: "/api/orders" }, read: { method: "GET", path: "/api/orders/status" } } as const;
const proofFile = { formatVersion: 1, configurations: ["default"], widths: [1280], routes: { selectionEntry: { one_time: "/select/one_time" } } } as const;
const verdicts: { verdict: StorefrontVerdict; double: Double }[] = [];

function options(double: Double, scenario: RunOptions["scenario"], extra: Partial<RunOptions> = {}): RunOptions {
  let now = 1_000_000;
  return {
    scenario, page: double.page, observer: double.observer, tier: "fixture_preview", profile: "default", width: 1280,
    commands, proofFile: { ...proofFile, routes: { selectionEntry: { ...proofFile.routes.selectionEntry } }, configurations: ["default"], widths: [1280] },
    build: { packages: [{ name: "@openlup/platform", version: "1.3.0" }], clients: [], proofFile: null },
    harness: { runnerVersion: "1.3.0" }, runId: "run-0001-abcd", clock: { now: () => (now += 7) }, quietMs: 0, timeoutMs: 0,
    ...extra,
  };
}

async function run(scenario: string, switches: StoreDoubleSwitches = {}, extra: Partial<RunOptions> = {}, doubleOptions: Parameters<typeof storeDouble>[1] = {}) {
  const double = storeDouble(switches, doubleOptions);
  const { kind, verdict } = await runStorefrontScenario(options(double, scenario, extra));
  expect(kind).toBe("verdict");
  verdicts.push({ verdict, double });
  return { verdict, double };
}

const codes = (verdict: StorefrontVerdict) => verdict.findings.map((finding) => finding.code);
const finding = (verdict: StorefrontVerdict, code: string) => verdict.findings.find((entry) => entry.code === code);
const stepsOf = (verdict: StorefrontVerdict, run: string) => verdict.steps.filter((step) => step.run === run);

describe.each([["synchronous", false], ["asynchronous", true]] as const)("a correct double, %s (R1)", (_mode, async) => {
  it("passes lost_response_reload with no adapter field, the control applied and one answer withheld per run", async () => {
    const { verdict, double } = await run("lost_response_reload", { async });
    expect(verdict.findings).toEqual([]);
    expect(verdict.result).toBe("passed");
    expect(verdict.harness.adapter).toEqual({ kind: "default", fields: [], digest: null });
    expect(verdict.control).toEqual({ kind: "block_read", negates: "awaiting_payment", applied: true });
    expect(verdict.stimulus).toEqual({ create: 2, read: 2 });
    expect([...double.withheld.entries()].sort()).toEqual([
      ["storefront-run-0001-abcd-clean@example.test", 1],
      ["storefront-run-0001-abcd-control@example.test", 1],
    ]);
    for (const run of ["clean", "control"]) {
      const steps = stepsOf(verdict, run);
      expect(steps.map((step) => step.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(steps.flatMap((step) => step.commands.map((command) => command.ordinal))).toEqual(
        steps.flatMap((step) => step.commands).map((_, index) => index));
    }
    expect(stepsOf(verdict, "clean").map((step) => step.phase)).toEqual(["arrange", "stimulus", "stimulus", "stimulus", "arrange", "stimulus", "observe", "settle"]);
    expect(stepsOf(verdict, "control").map((step) => step.phase)).toEqual(["arrange", "stimulus", "stimulus", "control", "control", "control", "control", "settle"]);
    expect(stepsOf(verdict, "clean")[6]).toMatchObject({ expectedAnchor: "state:awaiting_payment", path: "/checkout/pay" });
    expect(stepsOf(verdict, "clean")[6]!.observedAnchors).toEqual(["action:continue_payment", "state:awaiting_payment"]);
    expect(stepsOf(verdict, "control")[7]!.observedAnchors).not.toContain("state:awaiting_payment");
    expect(stepsOf(verdict, "clean")[7]!.ledger).toEqual({ orders: 1, payableOrders: 1, holds: 1, attempts: 0, captures: 0 });
    expect(double.calls.filter((call) => call === "intercept")).toHaveLength(2);
    expect(double.calls.filter((call) => call === "unintercept")).toHaveLength(2);
  });

  it("ends duplicate_submit safety_only with no control run", async () => {
    const { verdict } = await run("duplicate_submit", { async });
    expect(verdict.findings).toEqual([]);
    expect(verdict.result).toBe("safety_only");
    expect(verdict.control).toEqual({ kind: "none", negates: null, applied: false });
    expect(stepsOf(verdict, "control")).toEqual([]);
    expect(stepsOf(verdict, "clean").map((step) => step.index)).toEqual([0, 1, 2]);
    expect(stepsOf(verdict, "clean")[1]!.commands).toEqual([{ operation: "create", ordinal: 0, key: { present: true, sameAs: null } }]);
  });
});

describe("a held create is awaited (R2)", () => {
  it("reads the ledger only after both creates completed, and fails a double without a submit guard", async () => {
    const { verdict, double } = await run("duplicate_submit", { async: true, noSubmitGuard: true });
    expect(verdict.result).toBe("failed");
    expect(codes(verdict)).toEqual(["duplicate_order", "duplicate_hold"]);
    expect(finding(verdict, "duplicate_order")).toMatchObject({ run: "clean", step: 1 });
    // Ledger reads: before the arrangement, after the arrangement, after the double click.
    const ledgerReads = double.events.flatMap((event, index) => event === "ledger" ? [index] : []);
    const answered = double.events.flatMap((event, index) => event === "create:answered" ? [index] : []);
    expect(answered).toHaveLength(2);
    expect(ledgerReads[2]).toBeGreaterThan(Math.max(...answered));
    expect(stepsOf(verdict, "clean")[1]!.commands.map((command) => command.key)).toEqual([
      { present: true, sameAs: null }, { present: true, sameAs: null },
    ]);
  });
});

describe("ledger safety (R3–R5)", () => {
  it("fails a second order on reload, naming the run, step, texts and recheck (R3)", async () => {
    const { verdict } = await run("lost_response_reload", { newKeyOnReload: true }, {
      proofFile: { ...proofFile, configurations: ["default"], widths: [1280], routes: { selectionEntry: { one_time: "/select/one_time" } }, recheck: "npm run proof -- {scenario} --again {scenario}" },
    });
    expect(verdict.result).toBe("failed");
    const duplicate = finding(verdict, "duplicate_order")!;
    expect(duplicate).toMatchObject({ run: "clean", step: 5, recheck: "npm run proof -- lost_response_reload --again lost_response_reload" });
    expect(duplicate.observed).toBe("Step 5 (act place_order) of the clean run: the run's buyer has 2 payable orders; the scenario allows 1.");
    for (const text of [duplicate.observed, duplicate.cause, duplicate.fix, duplicate.recheck]) expect(text.length).toBeGreaterThan(10);
    const creates = (verdict: StorefrontVerdict) => stepsOf(verdict, "clean").flatMap((step) => step.commands).filter((command) => command.operation === "create");
    expect(creates(verdict).map((command) => command.key.sameAs)).toEqual([null, null]);
    const correct = await run("lost_response_reload");
    expect(creates(correct.verdict).map((command) => command.key.sameAs)).toEqual([null, 0]);
    expect(finding(correct.verdict, "duplicate_order")).toBeUndefined();
  });

  it("fails a replay that holds stock on a second order, and a second payable order (R4)", async () => {
    const hold = await run("lost_response_reload", { holdOnReplay: true });
    expect(hold.verdict.result).toBe("failed");
    expect(codes(hold.verdict)).toEqual(["duplicate_hold"]);
    expect(stepsOf(hold.verdict, "clean")[5]!.ledger).toEqual({ orders: 2, payableOrders: 1, holds: 2, attempts: 0, captures: 0 });
    const payable = await run("lost_response_reload", { secondPayableOrder: true });
    expect(payable.verdict.result).toBe("failed");
    expect(codes(payable.verdict)).toContain("duplicate_order");
  });

  it("fails a paid state without a capture, also when it appears only in the settle window (R5)", async () => {
    const early = await run("duplicate_submit", { showPaidEarly: true });
    expect(early.verdict.result).toBe("failed");
    expect(finding(early.verdict, "forbidden_state_shown")).toMatchObject({ run: "clean", step: 1 });
    const late = await run("duplicate_submit", { showPaidAfterSettle: true });
    expect(late.verdict.result).toBe("failed");
    expect(finding(late.verdict, "forbidden_state_shown")).toMatchObject({ run: "clean", step: 2 });
    expect(stepsOf(late.verdict, "clean")[2]).toMatchObject({ phase: "settle", action: null, expectedAnchor: null });
    expect(stepsOf(late.verdict, "clean")[1]!.observedAnchors).not.toContain("state:paid");
  });
});

describe("a lying harness ends not_run (R6)", () => {
  it("names a create matcher on an unused path", async () => {
    const { verdict } = await run("lost_response_reload", {}, { commands: { ...commands, create: { method: "POST", path: "/api/nothing" } } });
    expect(verdict.result).toBe("not_run");
    expect(finding(verdict, "adapter_matcher_unmatched")).toMatchObject({ run: "clean", field: "commands.create" });
  });

  it("names a hidden state anchor", async () => {
    const { verdict } = await run("lost_response_reload", { hideAwaitingPayment: true });
    expect(verdict.result).toBe("not_run");
    expect(codes(verdict)).toEqual(["anchor_hidden"]);
    expect(finding(verdict, "anchor_hidden")).toMatchObject({ run: "clean", step: 6 });
    expect(finding(verdict, "anchor_hidden")!.observed).toContain("state:awaiting_payment");
  });

  it("names a control that blocked nothing", async () => {
    const { verdict } = await run("lost_response_reload", { replayFromCache: true }, { commands: { ...commands, read: { method: "GET", path: "/api/unused" } } });
    expect(verdict.result).toBe("not_run");
    expect(verdict.control.applied).toBe(false);
    expect(finding(verdict, "control_not_applied")).toMatchObject({ run: "control", step: null });
    expect(finding(verdict, "adapter_matcher_unmatched")).toMatchObject({ field: "commands.read" });
  });

  it("names a throwing arrange function", async () => {
    const adapter: StorefrontAdapter = { arrange: async () => { throw new Error("arrange broke at /cart?token=secret-token-value"); } };
    const { verdict } = await run("lost_response_reload", {}, { adapter });
    expect(verdict.result).toBe("not_run");
    expect(codes(verdict)).toEqual(["arrange_failed"]);
    expect(finding(verdict, "arrange_failed")).toMatchObject({ run: "clean", step: 0, field: "arrange" });
    expect(stepsOf(verdict, "control")).toEqual([]);
  });

  it("names a withhold whose act sent nothing, and does not carry it to a later act", async () => {
    const { verdict, double } = await run("lost_response_reload", { firstSubmitSendsNothing: true });
    expect(verdict.result).toBe("not_run");
    expect(finding(verdict, "stimulus_not_applied")).toMatchObject({ run: "clean", step: 2 });
    expect(double.withheld.get("storefront-run-0001-abcd-clean@example.test")).toBeUndefined();
  });
});

describe("subject and stimulus ties (R7)", () => {
  it("names an arrangement that typed another buyer", async () => {
    const adapter: StorefrontAdapter = {
      async arrange({ page }) {
        await page.navigate("/select/one_time");
        await page.perform({ attribute: "action", value: "proceed_to_checkout" }, { timeoutMs: 0 });
        await page.fill({ attribute: "field", value: "email" }, "other@example.test", { timeoutMs: 0 });
      },
    };
    const { verdict } = await run("duplicate_submit", {}, { adapter });
    expect(verdict.result).toBe("not_run");
    expect(codes(verdict)).toEqual(["observer_subject_unseen"]);
    expect(finding(verdict, "observer_subject_unseen")!.cause).toContain("does not see the orders");
  });

  it("names an earlier order of the subject before anything is driven", async () => {
    const double = storeDouble();
    await runStorefrontScenario(options(double, "duplicate_submit"));
    const calls = double.calls.length;
    const { verdict } = await runStorefrontScenario(options(double, "duplicate_submit"));
    verdicts.push({ verdict, double });
    expect(verdict.result).toBe("not_run");
    expect(finding(verdict, "observer_subject_unseen")).toMatchObject({ run: "clean", step: null });
    expect(finding(verdict, "observer_subject_unseen")!.cause).toContain("not fresh");
    expect(double.calls.slice(calls)).toEqual([]);
  });

  it("names a create matcher on the quote path", async () => {
    const { verdict } = await run("duplicate_submit", {}, { commands: { ...commands, create: { method: "POST", path: "/api/quote" } } });
    expect(verdict.result).toBe("not_run");
    expect(finding(verdict, "stimulus_not_create")).toMatchObject({ run: "clean", step: 1 });
  });
});

describe("missing anchors and the adapter kind (R8)", () => {
  it("names a missing state anchor, and fails another state", async () => {
    const none = await run("lost_response_reload", { noStateAnchor: true });
    expect(none.verdict.result).toBe("not_run");
    expect(codes(none.verdict)).toEqual(["adapter_anchor_missing"]);
    expect(finding(none.verdict, "adapter_anchor_missing")!.observed).toContain("expected state:awaiting_payment; no state anchor is shown");
    const other = await run("lost_response_reload", { wrongState: true });
    expect(other.verdict.result).toBe("failed");
    expect(codes(other.verdict)).toEqual(["progress_not_reached"]);
    expect(finding(other.verdict, "progress_not_reached")!.observed).toContain("state:declined");
  });

  it("records a custom adapter's fields and digest, and uses its locators", async () => {
    const { verdict, double } = await run("lost_response_reload", {}, { adapter: { actions: { place_order: "#place" } }, harness: { runnerVersion: "1.3.0", adapterDigest: "sha256:abc" } },
      { locators: { "#place": "action:place_order" } });
    expect(verdict.result).toBe("passed");
    expect(verdict.harness.adapter).toEqual({ kind: "custom", fields: ["actions"], digest: "sha256:abc" });
    expect(double.calls).toContain("perform action:place_order");
    const plain = await run("duplicate_submit", {}, { adapter: { actions: { place_order: "#place" } } }, { locators: { "#place": "action:place_order" } });
    expect(plain.verdict.harness.adapter).toEqual({ kind: "custom", fields: ["actions"], digest: null });
  });
});

describe("an exclusive database (R9)", () => {
  it("fails orders created for another buyer, and refuses to attribute a smaller delta", async () => {
    const outside = await run("lost_response_reload", { createsForOtherBuyer: true }, {}, { exclusive: true });
    expect(outside.verdict.result).toBe("failed");
    expect(finding(outside.verdict, "order_outside_subject")).toMatchObject({ run: "clean", step: null });
    const paid = await run("lost_response_reload", { otherBuyerPays: true }, {}, { exclusive: true });
    expect(paid.verdict.result).toBe("not_run");
    expect(codes(paid.verdict)).toEqual(["observer_failed"]);
    expect(finding(paid.verdict, "observer_failed")!.observed).toContain("gained 0 payable orders while the run's buyer gained 1");
    const correct = await run("lost_response_reload", {}, {}, { exclusive: true });
    expect(correct.verdict.result).toBe("passed");
  });
});

describe("faults of collaborators (R10)", () => {
  it("ends not_run when the observer rejects", async () => {
    const { verdict } = await run("lost_response_reload", { observerRejects: true });
    expect(verdict.result).toBe("not_run");
    expect(verdict.findings).toHaveLength(1);
    expect(finding(verdict, "observer_failed")).toMatchObject({ run: "clean", step: null });
  });

  it("ends not_run with the step when the page cannot navigate", async () => {
    const { verdict } = await run("lost_response_reload", { navigateRejects: true });
    expect(verdict.result).toBe("not_run");
    expect(codes(verdict)).toEqual(["page_failed"]);
    expect(finding(verdict, "page_failed")).toMatchObject({ run: "clean", step: 0 });
  });
});

describe("the create budget (R11)", () => {
  it("stops a run that keeps sending creates", async () => {
    const { verdict } = await run("duplicate_submit", { resubmitLoop: true });
    expect(verdict.result).toBe("not_run");
    expect(codes(verdict)).toEqual(["request_budget_exceeded"]);
    expect(finding(verdict, "request_budget_exceeded")).toMatchObject({ run: "clean", step: 1 });
    expect(finding(verdict, "request_budget_exceeded")!.observed).toContain("sent 4 create requests; the scenario allows 2");
  });
});

describe("reload re-entry (R13)", () => {
  it("navigates to the selection entry again when one is declared", async () => {
    const { double } = await run("lost_response_reload");
    const firstReload = double.calls.indexOf("reload");
    expect(double.calls.slice(firstReload)).toContain("navigate /select/one_time");
  });

  it("re-types only the details without a selection entry and with a custom arrange", async () => {
    const adapter: StorefrontAdapter = {
      async arrange({ page, buyer }) {
        await page.navigate("/select/one_time");
        await page.perform({ attribute: "action", value: "proceed_to_checkout" }, { timeoutMs: 0 });
        for (const [field, value] of Object.entries(buyer)) await page.fill({ attribute: "field", value: field }, value, { timeoutMs: 0 });
      },
    };
    const { verdict, double } = await run("lost_response_reload", {}, { adapter, proofFile: { formatVersion: 1, configurations: ["default"], widths: [1280] } });
    expect(verdict.result).toBe("passed");
    const firstReload = double.calls.indexOf("reload");
    const rearrangement = double.calls.slice(firstReload + 1, double.calls.indexOf("perform action:place_order", firstReload));
    expect(rearrangement.some((call) => call.startsWith("navigate"))).toBe(false);
    expect(rearrangement.filter((call) => call.startsWith("fill"))).toContain("fill field:email");
  });

  it("ends arrange_failed without a selection entry and without an arrange function", async () => {
    const { verdict, double } = await run("duplicate_submit", {}, { proofFile: { formatVersion: 1, configurations: ["default"], widths: [1280] } });
    expect(verdict.result).toBe("not_run");
    expect(finding(verdict, "arrange_failed")).toMatchObject({ run: "clean", step: 0, field: "routes.selectionEntry" });
    expect(double.calls.some((call) => call.startsWith("navigate"))).toBe(false);
  });
});

describe("input and admission", () => {
  const refusals: [string, Partial<RunOptions>, string][] = [
    ["an unknown scenario", { scenario: "lost_response_unknown" }, "storefront_scenario_unknown"],
    ["a short runId", { runId: "short" }, "storefront_run_input_invalid"],
    ["a runId with a dot", { runId: "run.0001.abcd" }, "storefront_run_input_invalid"],
    ["a missing width", { width: undefined }, "storefront_run_input_invalid"],
    ["a width the page does not have", { width: 390 }, "storefront_run_input_invalid"],
    ["a clock before the epoch", { clock: { now: () => -1 } }, "storefront_run_input_invalid"],
    ["a fractional clock", { clock: { now: () => 1.5 } }, "storefront_run_input_invalid"],
    ["an unknown tier spelling", { tier: "Postgres" }, "storefront_run_input_invalid"],
  ];
  it.each(refusals)("refuses %s and drives nothing", async (_name, extra, code) => {
    const double = storeDouble();
    await expect(runStorefrontScenario(options(double, "lost_response_reload", extra))).rejects.toThrow(new RegExp(`^${code}: .+ Cause: .+ Fix: .+ Recheck: `));
    expect(double.calls).toEqual([]);
    expect(double.events).toEqual([]);
  });

  it("ends a scenario whose outcome is not declared not_run before any page or observer call", async () => {
    const double = storeDouble();
    const scenario: StorefrontScenario = { ...storefrontScenarios[1]!, id: "needs_later_outcome", requires: { outcomes: ["kind_added_later", "settled"] } };
    const { verdict } = await runStorefrontScenario(options(double, scenario));
    verdicts.push({ verdict, double });
    expect(verdict.result).toBe("not_run");
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]).toMatchObject({ code: "tier_unreachable", run: null, step: null });
    expect(verdict.findings[0]!.cause).toContain("kind_added_later, settled");
    expect(verdict.harness.declaredOutcomes).toEqual([]);
    expect(verdict.steps).toEqual([]);
    expect(double.calls).toEqual([]);
    expect(double.events).toEqual([]);
  });
});

describe("the verdict shape (R12)", () => {
  it("gives every verdict above to the parser, with no key value and no query", () => {
    expect(verdicts.length).toBeGreaterThan(25);
    for (const { verdict, double } of verdicts) {
      expect(parseStorefrontVerdict(JSON.stringify(verdict)).ok).toBe(true);
      const text = serializeStorefrontVerdict(verdict);
      for (const key of double.keysSent) expect(text).not.toContain(key);
      expect(text).not.toContain("secret");
      expect(verdict.build.source).toBe("claimed");
      expect(verdict.completedAt).toMatch(/^1970-01-01T00:16:40\.\d{3}Z$/);
    }
    expect(verdicts.some(({ double }) => double.keysSent.length > 0)).toBe(true);
  });

  it("copies a ci build source", async () => {
    const { verdict } = await run("duplicate_submit", {}, { build: { source: "ci", packages: [], clients: [], proofFile: null } });
    expect(verdict.build).toEqual({ source: "ci", packages: [], clients: [], proofFile: null });
  });
});
