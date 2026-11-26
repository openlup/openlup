import { describe, expect, it } from "vitest";
import { parseStorefrontVerdict, type StorefrontVerdict } from "../../../src/lifecycle/index.js";
import { runStorefrontScenario, serializeStorefrontVerdict, storefrontScenarios, type StorefrontAdapter, type StorefrontScenario } from "../../../src/storefront/testing/index.js";
import { findingText } from "../../../src/storefront/testing/findings.js";
import { ALL_OUTCOMES, storeDouble, type StoreDoubleSwitches } from "./storeDouble.js";

/** The cause text of forbidden_state_shown for one cause. */
const findingCause = (cause: string) => findingText("forbidden_state_shown", cause, { at: "x" }).cause;

type RunOptions = Parameters<typeof runStorefrontScenario>[0];
type Double = ReturnType<typeof storeDouble>;

const commands = { create: { method: "POST", path: "/api/orders" }, read: { method: "GET", path: "/api/orders/status" } } as const;
const proofFile = {
  formatVersion: 1, configurations: ["default"], widths: [1280], routes: { selectionEntry: { one_time: "/select/one_time", subscription: "/select/subscription" } },
} as const;
const verdicts: { verdict: StorefrontVerdict; double: Double }[] = [];

/** The test proof file with extra fields. */
const proofWith = (extra: Partial<NonNullable<RunOptions["proofFile"]>>): NonNullable<RunOptions["proofFile"]> => ({
  ...proofFile, configurations: ["default"], widths: [1280], routes: { selectionEntry: { ...proofFile.routes.selectionEntry } }, ...extra,
});

/** The verdict of a full run; a stopped run fails the test. */
function verdictOf(result: Awaited<ReturnType<typeof runStorefrontScenario>>): StorefrontVerdict {
  if (result.kind !== "verdict") throw new Error(`expected a verdict, got ${result.kind}`);
  return result.verdict;
}

function options(double: Double, scenario: RunOptions["scenario"], extra: Partial<RunOptions> = {}): RunOptions {
  let now = 1_000_000;
  return {
    scenario, page: double.page, observer: double.observer, outcomes: double.outcomes, tier: "fixture_preview", profile: "default", width: 1280,
    commands, proofFile: proofWith({}),
    build: { packages: [{ name: "@openlup/platform", version: "1.3.0" }], clients: [], proofFile: null },
    harness: { runnerVersion: "1.3.0" }, runId: "run-0001-abcd", clock: { now: () => (now += 7) }, quietMs: 0, timeoutMs: 0,
    ...extra,
  };
}

async function run(scenario: string, switches: StoreDoubleSwitches = {}, extra: Partial<RunOptions> = {}, doubleOptions: Parameters<typeof storeDouble>[1] = {}) {
  const double = storeDouble(switches, doubleOptions);
  const verdict = verdictOf(await runStorefrontScenario(options(double, scenario, extra)));
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
    const verdict = verdictOf(await runStorefrontScenario(options(double, "duplicate_submit")));
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
    // The fault's code and first sentence are kept; a URL in it, with its credentials and query, is not.
    expect(finding(verdict, "observer_failed")!.observed).toBe("Before the arrangement of the clean run: the observer rejected (observer_unreachable: connect <url> failed.).");
  });

  it("ends not_run with the step when the page cannot navigate", async () => {
    const { verdict } = await run("lost_response_reload", { navigateRejects: true });
    expect(verdict.result).toBe("not_run");
    expect(codes(verdict)).toEqual(["page_failed"]);
    expect(finding(verdict, "page_failed")).toMatchObject({ run: "clean", step: 0 });
  });
});

describe("the control run (R14)", () => {
  it.each([["synchronous", false], ["asynchronous", true]] as const)("ends vacuous when the page shows the negated state from its own state (%s)", async (_mode, async) => {
    const { verdict } = await run("lost_response_reload", { async, progressFromPageState: true });
    expect(verdict.result).toBe("vacuous");
    expect(codes(verdict)).toEqual(["vacuous_progress"]);
    expect(finding(verdict, "vacuous_progress")).toMatchObject({ run: "control", step: 3 });
    expect(verdict.control.applied).toBe(true);
  });

  it("judges a control run that showed the negated state and then could not arrange again", async () => {
    const { verdict } = await run("lost_response_reload", { async: true, progressFromPageState: true, stuckInPageState: true });
    expect(verdict.result).toBe("vacuous");
    expect(codes(verdict)).toEqual(["vacuous_progress"]);
    expect(finding(verdict, "vacuous_progress")).toMatchObject({ run: "control", step: 3 });
    // The steps after the failed arrangement are skipped, but the control's settle window is still read.
    expect(stepsOf(verdict, "control").map((step) => [step.index, step.phase])).toEqual([
      [0, "arrange"], [1, "stimulus"], [2, "stimulus"], [3, "control"], [4, "control"], [7, "settle"],
    ]);
    expect(stepsOf(verdict, "control").at(-1)!.observedAnchors).toContain("state:awaiting_payment");
  });

  it("judges the negated state over the recorded steps of a control run that stopped on a fault", async () => {
    const { verdict } = await run("lost_response_reload", { progressFromPageState: true, stuckInPageState: true, stuckNavigateRejects: true });
    expect(verdict.result).toBe("not_run");
    expect(codes(verdict)).toEqual(["page_failed", "vacuous_progress"]);
    expect(finding(verdict, "page_failed")).toMatchObject({ run: "control", step: 4 });
    expect(finding(verdict, "vacuous_progress")).toMatchObject({ run: "control", step: 3 });
  });

  it("gives the negated state only the quiet window, and the clean expect the full timeout", async () => {
    const { double } = await run("lost_response_reload", {}, { quietMs: 5, timeoutMs: 50 });
    expect(double.findTimeouts.filter(([name]) => name === "state:awaiting_payment")).toEqual([["state:awaiting_payment", 50], ["state:awaiting_payment", 5]]);
    expect(double.findTimeouts.filter(([name]) => name === "action:continue_payment")).toEqual([["action:continue_payment", 50]]);
  });

  it("names a blocked set that matched nothing from the control's step on", async () => {
    const { verdict } = await run("lost_response_reload", { replayFromCache: true, statusReadOnFirstCheckout: true });
    expect(verdict.result).toBe("not_run");
    const unmatched = verdict.findings.filter((entry) => entry.code === "adapter_matcher_unmatched");
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]).toMatchObject({ run: "clean", step: null, field: "commands" });
    expect(unmatched[0]!.observed).toBe("The clean run: no read or create request matched from step 3 on.");
  });
});

describe("attempts, captures and offers (R15)", () => {
  it("fails a second payment attempt and a second capture", async () => {
    const attempts = await run("duplicate_submit", { twoAttempts: true });
    expect(attempts.verdict.result).toBe("failed");
    expect(codes(attempts.verdict)).toEqual(["second_attempt"]);
    expect(finding(attempts.verdict, "second_attempt")).toMatchObject({ run: "clean", step: 1 });
    const captures = await run("duplicate_submit", { doubleCapture: true });
    expect(captures.verdict.result).toBe("failed");
    expect(codes(captures.verdict)).toEqual(["duplicate_capture"]);
  });

  it("names a progress state that does not offer its action", async () => {
    const { verdict } = await run("lost_response_reload", { noContinuePayment: true });
    expect(verdict.result).toBe("not_run");
    expect(codes(verdict)).toEqual(["adapter_anchor_missing"]);
    expect(finding(verdict, "adapter_anchor_missing")).toMatchObject({ run: "clean", step: 6 });
    expect(finding(verdict, "adapter_anchor_missing")!.observed).toContain("the action action:continue_payment did not resolve");
  });
});

describe("the double click (R16)", () => {
  it.each([["synchronous", false], ["asynchronous", true]] as const)("holds the first create until the second click was attempted (%s)", async (_mode, async) => {
    const { verdict, double } = await run("duplicate_submit", { async, noSubmitGuardSameKey: true });
    expect(verdict.result).toBe("safety_only");
    // The second click's create reaches the server first: the first was held while the second was attempted.
    expect(double.arrivals).toEqual([2, 1]);
    expect(stepsOf(verdict, "clean")[1]!.commands.map((command) => command.key)).toEqual([
      { present: true, sameAs: null }, { present: true, sameAs: 0 },
    ]);
  });
});

describe("the create budget (R11)", () => {
  it("ranks duplicates already in the ledger above the exceeded budget", async () => {
    const { verdict } = await run("duplicate_submit", { noSubmitGuard: true, resubmitLoop: true });
    expect(verdict.result).toBe("failed");
    expect(codes(verdict)).toEqual(["duplicate_order", "duplicate_hold", "request_budget_exceeded"]);
  });

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
    ["a scenario object without steps", { scenario: { ...storefrontScenarios[1]!, id: "broken_one", steps: undefined } as never }, "storefront_run_input_invalid"],
    ["a scenario object without a budget", { scenario: { ...storefrontScenarios[1]!, id: "broken_two", budget: undefined } as never }, "storefront_run_input_invalid"],
    ["a scenario object with a negative budget", { scenario: { ...storefrontScenarios[1]!, id: "broken_three", budget: { creates: -1 } } }, "storefront_run_input_invalid"],
    ["a scenario object with an act and no action", { scenario: { ...storefrontScenarios[1]!, id: "broken_four", steps: [{ kind: "arrange" }, { kind: "act" }] } as never }, "storefront_run_input_invalid"],
    ["a scenario object whose control starts past its steps", { scenario: { ...storefrontScenarios[0]!, id: "broken_five", control: { ...storefrontScenarios[0]!.control, from: 9 } } }, "storefront_run_input_invalid"],
    ["a scenario object without requires", { scenario: { ...storefrontScenarios[1]!, id: "broken_six", requires: undefined } as never }, "storefront_run_input_invalid"],
    ["a scenario object with an outcome step and no outcome", { scenario: { ...storefrontScenarios[1]!, id: "broken_seven", steps: [{ kind: "arrange" }, { kind: "outcome" }] } as never }, "storefront_run_input_invalid"],
    ["a scenario object whose outcome step is not required", {
      scenario: { ...storefrontScenarios[1]!, id: "broken_eight", steps: [{ kind: "arrange" }, { kind: "outcome", outcome: "settled" }] },
    }, "storefront_run_input_invalid"],
    ["a scenario object omitting an action it never performs", {
      scenario: { ...storefrontScenarios[1]!, id: "broken_nine", control: { kind: "omit_action", action: "retry_payment", negates: "paid" } },
    }, "storefront_run_input_invalid"],
    ["a scenario object with an other_policy control and no expect by policy", {
      scenario: { ...storefrontScenarios[0]!, id: "broken_ten", control: { kind: "other_policy", negates: null } },
    }, "storefront_run_input_invalid"],
    ["a scenario object with forbidden states in the single-window shape", {
      scenario: { ...storefrontScenarios[1]!, id: "broken_eleven", safety: { forbiddenStates: { after: 1, states: ["paid"] } } } as never,
    }, "storefront_run_input_invalid"],
    ["an outcome driver without produce", { outcomes: { capabilities: ["settled"] } as never }, "storefront_run_input_invalid"],
    ["an outcome driver declaring a capability that is not a name", { outcomes: { capabilities: ["settled", "Settled!"], produce: async () => undefined } }, "storefront_run_input_invalid: outcomes.capabilities\\[1\\] is \"Settled!\""],
    ["an outcome driver declaring a capability that is not a string", { outcomes: { capabilities: [7], produce: async () => undefined } as never }, "storefront_run_input_invalid: outcomes.capabilities\\[0\\] is 7"],
  ];
  it.each(refusals)("refuses %s and drives nothing", async (_name, extra, code) => {
    const double = storeDouble();
    await expect(runStorefrontScenario(options(double, "lost_response_reload", extra))).rejects.toThrow(new RegExp(`^${code}${code.includes(":") ? "" : ": "}.+ Cause: .+ Fix: .+ Recheck: `));
    expect(double.calls).toEqual([]);
    expect(double.events).toEqual([]);
  });

  it("ends a scenario whose outcome is not declared not_run before any page or observer call", async () => {
    const double = storeDouble();
    const scenario: StorefrontScenario = { ...storefrontScenarios[1]!, id: "needs_later_outcome", requires: { outcomes: ["kind_added_later", "settled"] } };
    const verdict = verdictOf(await runStorefrontScenario(options(double, scenario, { outcomes: undefined })));
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

const CLEAN = "storefront-run-0001-abcd-clean@example.test";
const CONTROL = "storefront-run-0001-abcd-control@example.test";
const producedBy = (double: Double, subject: string) => double.produced.filter(([who]) => who === subject).map(([, outcome]) => outcome);

describe.each([["synchronous", false], ["asynchronous", true]] as const)("all six scenarios on a correct double, %s (R20)", (_mode, async) => {
  const controls: Record<string, StorefrontVerdict["control"]> = {
    lost_response_reload: { kind: "block_read", negates: "awaiting_payment", applied: true },
    duplicate_submit: { kind: "none", negates: null, applied: false },
    lost_response_edited_payload: { kind: "other_policy", negates: "awaiting_payment", applied: true },
    reload_pending_attempt: { kind: "block_read", negates: "paid", applied: true },
    decline_retry: { kind: "omit_action", action: "retry_payment", negates: "paid", applied: true },
    paid_pending_activation: { kind: "block_read", negates: "paid_pending_activation", applied: true },
  };
  it.each(storefrontScenarios.map((scenario) => scenario.id))("%s passes with its control applied", async (id) => {
    const { verdict } = await run(id, { async });
    expect(verdict.findings).toEqual([]);
    expect(verdict.result).toBe(id === "duplicate_submit" ? "safety_only" : "passed");
    expect(verdict.control).toEqual(controls[id]);
    expect(verdict.harness.declaredOutcomes).toEqual([...ALL_OUTCOMES]);
  });

  it("passes the edited payload under a declared update_in_place, negating details_changed", async () => {
    const { verdict } = await run("lost_response_edited_payload", { async, updateInPlace: true }, { proofFile: proofWith({ changedPayloadPolicy: "update_in_place" }) });
    expect(verdict.findings).toEqual([]);
    expect(verdict.result).toBe("passed");
    expect(verdict.control).toEqual({ kind: "other_policy", negates: "details_changed", applied: true });
    expect(stepsOf(verdict, "clean")[6]).toMatchObject({ expectedAnchor: "state:awaiting_payment" });
  });
});

describe("an omitted action (R21)", () => {
  it("skips the outcomes after the omitted action, and ends vacuous when the state is reached without it", async () => {
    const correct = await run("decline_retry");
    expect(producedBy(correct.double, CLEAN)).toEqual(["declined", "settled"]);
    expect(producedBy(correct.double, CONTROL)).toEqual(["declined"]);
    expect(stepsOf(correct.verdict, "control")[6]).toMatchObject({ phase: "control", action: null });
    expect(correct.double.calls.filter((call) => call === "perform action:retry_payment")).toHaveLength(1);
    const { verdict } = await run("decline_retry", { progressWithoutRetry: true });
    expect(verdict.result).toBe("vacuous");
    expect(codes(verdict)).toEqual(["vacuous_progress"]);
    expect(finding(verdict, "vacuous_progress")).toMatchObject({ run: "control", step: 6 });
    expect(finding(verdict, "vacuous_progress")!.cause).toContain("without the omitted action");
  });
});

describe("declared auto-progress (R22, R23)", () => {
  it("passes a page that retries by itself when it is declared, with a read-blocking control and no retry click (R22)", async () => {
    const { verdict, double } = await run("decline_retry", { autoRetry: true }, { proofFile: proofWith({ autoProgress: ["retry_payment"] }) });
    expect(verdict.findings).toEqual([]);
    expect(verdict.result).toBe("passed");
    expect(verdict.control).toEqual({ kind: "block_read", negates: "paid", applied: true });
    expect(double.calls).not.toContain("perform action:retry_payment");
    expect(stepsOf(verdict, "clean")[6]).toMatchObject({ action: null });
    // The control blocks reads from the step before the omitted action.
    expect(stepsOf(verdict, "control").map((step) => step.phase).slice(4, 7)).toEqual(["stimulus", "control", "control"]);
    expect(verdict.harness.autoProgress).toEqual(["retry_payment"]);
  });

  it("names a page that retries by itself without declaring it (R23)", async () => {
    const { verdict } = await run("decline_retry", { autoRetry: true });
    expect(verdict.result).toBe("not_run");
    expect(codes(verdict)).toEqual(["auto_progress_undeclared"]);
    expect(finding(verdict, "auto_progress_undeclared")).toMatchObject({ run: "control", step: 6 });
    expect(finding(verdict, "auto_progress_undeclared")!.fix).toContain("autoProgress");
    expect(finding(verdict, "auto_progress_undeclared")!.observed).toContain("retry_payment");
  });
});

describe("the changed-payload policy (R24)", () => {
  it.each([
    ["declared refuse_changed", { changedPayloadPolicy: "refuse_changed" }],
    ["no declared policy", {}],
    ["a policy this runner does not know", { changedPayloadPolicy: "merge_later" }],
  ] as const)("fails a store that updates in place under %s", async (_name, policy) => {
    const { verdict } = await run("lost_response_edited_payload", { updateInPlace: true }, { proofFile: proofWith(policy) });
    expect(verdict.result).toBe("failed");
    // The control run handles the changed details the same way, so it shows the other policy's progress too.
    expect(codes(verdict)).toEqual(["policy_mismatch", "vacuous_progress"]);
    expect(finding(verdict, "policy_mismatch")).toMatchObject({ run: "clean", step: 6 });
    expect(finding(verdict, "policy_mismatch")!.observed).toContain("state:awaiting_payment");
    expect(verdict.control.negates).toBe("awaiting_payment");
  });

  it("ends vacuous when the control run shows the other policy's progress", async () => {
    const { verdict } = await run("lost_response_edited_payload", { updateInPlaceForControl: true });
    expect(verdict.result).toBe("vacuous");
    expect(codes(verdict)).toEqual(["vacuous_progress"]);
    expect(finding(verdict, "vacuous_progress")).toMatchObject({ run: "control", step: 6 });
  });
});

describe("a pending attempt and a reload (R25, R26)", () => {
  it("negates only paid: awaiting_authority under the control passes, paid from page state is vacuous (R25)", async () => {
    const correct = await run("reload_pending_attempt");
    expect(correct.verdict.result).toBe("passed");
    expect(stepsOf(correct.verdict, "control")[7]!.observedAnchors).toContain("state:awaiting_authority");
    expect(producedBy(correct.double, CONTROL)).toEqual(["pending", "settled_after_pending"]);
    const { verdict } = await run("reload_pending_attempt", { paidFromLocalState: true });
    expect(verdict.result).toBe("vacuous");
    expect(codes(verdict)).toEqual(["vacuous_progress"]);
    expect(finding(verdict, "vacuous_progress")).toMatchObject({ run: "control", step: 8 });
  });

  it("fails a new payment attempt on reload (R26)", async () => {
    const { verdict } = await run("reload_pending_attempt", { newAttemptOnReload: true });
    expect(verdict.result).toBe("failed");
    expect(finding(verdict, "second_attempt")).toMatchObject({ run: "clean", step: 6 });
    expect(finding(verdict, "second_attempt")!.observed).toContain("2 payment attempts; the scenario allows 1");
  });

  it("fails more attempts than declines plus one", async () => {
    const { verdict } = await run("decline_retry", { retryStartsTwo: true });
    expect(verdict.result).toBe("failed");
    expect(codes(verdict)).toEqual(["second_attempt"]);
    expect(finding(verdict, "second_attempt")).toMatchObject({ run: "clean", step: 6 });
    expect(finding(verdict, "second_attempt")!.observed).toContain("3 payment attempts; the scenario allows 2");
  });
});

describe("paid with activation pending: the forbidden-state matrix (R27)", () => {
  // Per run: the control run (status reads blocked from the outcome on) may never show an outcome it cannot know; the
  // clean run may never show an outcome the scenario rules out, nor regress to a pre-outcome state once it showed the
  // expected one. Awaiting states stay allowed in the control run.
  // The state the control negates is not in the control list: a page that shows it is judged vacuous, as in every other
  // block_read scenario, because the runner cannot tell a guess from a page that learned it over an unmatched request.
  const rows: readonly (readonly [string, StoreDoubleSwitches, "passed" | "failed" | "vacuous", readonly [string, number, string, string] | null])[] = [
    ["a correct store", {}, "passed", null],
    ["an honest polling store (awaiting_payment until its poll answers; the control run keeps it)", { slowPoll: true, awaitingPaymentUntilPoll: true }, "passed", null],
    ["a control run that falls back to awaiting_payment when its read fails", { awaitingPaymentWhenReadFails: true }, "passed", null],
    ["a control run that shows paid when its read fails", { paidWhenReadFails: true }, "failed", ["control", 4, "unknowable", "state:paid"]],
    ["a control run that shows declined when its read fails", { declinedWhenReadFails: true }, "failed", ["control", 4, "unknowable", "state:declined"]],
    ["a control run that shows the negated outcome from page state", { activationFromPageState: true }, "vacuous", ["control", 4, "vacuous_progress", "state:paid_pending_activation"]],
    ["a clean run that shows paid beside the outcome", { showPaidWhilePending: true }, "failed", ["clean", 4, "ruled_out", "state:paid"]],
    ["a clean run that regresses to awaiting_payment after it showed the outcome", { fallsBackAfterShowing: true }, "failed", ["clean", 5, "regression", "state:awaiting_payment"]],
  ];
  it.each(rows)("%s", async (_name, switches, result, expected) => {
    const { verdict } = await run("paid_pending_activation", switches);
    expect(verdict.result).toBe(result);
    if (expected === null) {
      expect(verdict.findings).toEqual([]);
      return;
    }
    const [runName, step, cause, state] = expected;
    if (cause === "vacuous_progress") {
      expect(codes(verdict)).toEqual(["vacuous_progress"]);
      expect(finding(verdict, "vacuous_progress")).toMatchObject({ run: runName, step });
      return;
    }
    expect(codes(verdict)[0]).toBe("forbidden_state_shown");
    const forbidden = verdict.findings.filter((entry) => entry.code === "forbidden_state_shown");
    expect(forbidden).toHaveLength(1);
    expect(forbidden[0]).toMatchObject({ run: runName, step });
    expect(forbidden[0]!.observed).toContain(state);
    expect(forbidden[0]!.cause).toBe(findingCause(cause));
  });

  it("lets the honest polling store keep awaiting_payment through the control run", async () => {
    const { verdict } = await run("paid_pending_activation", { slowPoll: true, awaitingPaymentUntilPoll: true });
    expect(stepsOf(verdict, "clean")[4]!.observedAnchors).toContain("state:awaiting_payment");
    expect(stepsOf(verdict, "clean")[5]!.observedAnchors).toContain("state:paid_pending_activation");
    expect(stepsOf(verdict, "control")[5]!.observedAnchors).toContain("state:awaiting_payment");
    expect(stepsOf(verdict, "control").at(-1)!.observedAnchors).toContain("state:awaiting_payment");
  });
});

describe("admission by declared outcomes (R28)", () => {
  const partial = ["activation_pending", "declined", "pending", "settled"];
  it.each(["fixture_preview", "postgres_sandbox"])("refuses a scenario whose outcome is not declared, before any call, at %s", async (tier) => {
    const { verdict, double } = await run("reload_pending_attempt", {}, { tier }, { capabilities: partial });
    expect(verdict.result).toBe("not_run");
    expect(codes(verdict)).toEqual(["tier_unreachable"]);
    expect(verdict.findings[0]).toMatchObject({ run: null, step: null });
    expect(verdict.findings[0]!.cause).toContain("needs the outcomes settled_after_pending, which");
    expect(verdict.harness.declaredOutcomes).toEqual(partial);
    expect(double.calls).toEqual([]);
    expect(double.events).toEqual([]);
    expect(double.produced).toEqual([]);
  });

  it("refuses a required outcome this runner does not know, even when the driver declares it", async () => {
    const double = storeDouble({}, { capabilities: [...ALL_OUTCOMES, "kind_added_later"] });
    const scenario: StorefrontScenario = { ...storefrontScenarios[1]!, id: "needs_later_kind", requires: { outcomes: ["kind_added_later"] } };
    const verdict = verdictOf(await runStorefrontScenario(options(double, scenario)));
    verdicts.push({ verdict, double });
    expect(verdict.result).toBe("not_run");
    expect(codes(verdict)).toEqual(["tier_unreachable"]);
    expect(verdict.findings[0]!.cause).toContain("kind_added_later");
    expect(verdict.harness.declaredOutcomes).toEqual([...ALL_OUTCOMES, "kind_added_later"].sort());
    expect(double.calls).toEqual([]);
    expect(double.events).toEqual([]);
  });

  it("runs the others when the driver declares an unknown capability", async () => {
    const { verdict } = await run("decline_retry", {}, {}, { capabilities: ["settled", "mystery_kind", "declined"] });
    expect(verdict.result).toBe("passed");
    expect(verdict.harness.declaredOutcomes).toEqual(["declined", "mystery_kind", "settled"]);
  });
});

describe("faults of the outcome driver (R29)", () => {
  it("ends not_run when produce rejects", async () => {
    const { verdict } = await run("decline_retry", { driverRejects: true });
    expect(verdict.result).toBe("not_run");
    expect(codes(verdict)).toEqual(["outcome_failed"]);
    expect(finding(verdict, "outcome_failed")).toMatchObject({ run: "clean", step: 4, field: "outcomes" });
    expect(finding(verdict, "outcome_failed")!.observed).toContain("(outcome_driver_unavailable: the sandbox at <url> refused.).");
    expect(stepsOf(verdict, "control")).toEqual([]);
  });

  it("ends not_run when produce resolves but the ledger shows no attempt", async () => {
    const { verdict } = await run("decline_retry", { continueSendsNothing: true });
    expect(verdict.result).toBe("not_run");
    expect(codes(verdict)).toEqual(["outcome_failed"]);
    expect(finding(verdict, "outcome_failed")).toMatchObject({ run: "clean", step: 4 });
    expect(finding(verdict, "outcome_failed")!.cause).toContain("no payment attempt");
  });
});

describe("stop-at (R30)", () => {
  it("drives to the state, removes its interceptor and writes no verdict", async () => {
    const double = storeDouble();
    const result = await runStorefrontScenario({ ...options(double, "decline_retry"), stopAt: "checkout.declined" });
    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.stoppedAt).toBe("checkout.declined");
    expect("verdict" in result).toBe(false);
    expect(result.steps.map((step) => step.index)).toEqual([0, 1, 2, 3, 4]);
    expect(result.steps.every((step) => step.run === "clean")).toBe(true);
    expect(await double.page.anchors()).toContain("state:declined");
    expect(double.calls.filter((call) => call === "intercept")).toHaveLength(1);
    expect(double.calls.at(-1)).toBe("unintercept");
    expect(double.produced).toEqual([[CLEAN, "declined"]]);
  });

  it("refuses a state the scenario does not expect, driving nothing", async () => {
    const double = storeDouble();
    for (const stopAt of ["checkout.unknown", "checkout.paid_pending_activation", "declined"]) {
      await expect(runStorefrontScenario({ ...options(double, "decline_retry"), stopAt }))
        .rejects.toThrow(/^storefront_stop_state_unknown: .+ Cause: .+ Fix: .+ Recheck: /);
    }
    expect(double.calls).toEqual([]);
  });

  it("refuses to stop in a scenario that is not admitted, driving nothing", async () => {
    const double = storeDouble({}, { capabilities: ["settled"] });
    await expect(runStorefrontScenario({ ...options(double, "decline_retry"), stopAt: "checkout.declined" }))
      .rejects.toThrow(/^storefront_stop_state_unreached: Scenario decline_retry was not admitted: the outcome driver does not declare declined\. Cause: /);
    expect(double.calls).toEqual([]);
    expect(double.events).toEqual([]);
    expect(double.produced).toEqual([]);
  });

  it("refuses a state the run never showed, naming the last step", async () => {
    const double = storeDouble({ neverDeclines: true });
    await expect(runStorefrontScenario({ ...options(double, "decline_retry"), stopAt: "checkout.declined" }))
      .rejects.toThrow(/^storefront_stop_state_unreached: Step 7 \(outcome settled\) of the clean run was the last step, and state:declined was not visible after any step \(first finding: /);
    expect(double.calls.at(-1)).toBe("unintercept");
  });
});

describe("declared auto-progress the page does not perform (R31)", () => {
  it("ends not_run naming autoProgress when the skipped action is still offered and the state is not reached", async () => {
    const { verdict, double } = await run("decline_retry", {}, { proofFile: proofWith({ autoProgress: ["retry_payment"] }) });
    expect(verdict.result).toBe("not_run");
    expect(codes(verdict)).toEqual(["auto_progress_not_performed"]);
    expect(finding(verdict, "auto_progress_not_performed")).toMatchObject({ run: "clean", step: 7, field: "autoProgress" });
    expect(finding(verdict, "auto_progress_not_performed")!.observed).toContain("action:retry_payment");
    expect(stepsOf(verdict, "control")).toEqual([]);
    expect(double.calls).not.toContain("perform action:retry_payment");
  });
});

describe("the ledger effect of each outcome (R32)", () => {
  it.each([
    ["answers settled by leaving the attempt pending", "decline_retry", { driverSettlesAsPending: true }, 7],
    ["answers settled without acting", "decline_retry", { driverIgnoresSettle: true }, 7],
    ["answers activation_pending without acting", "paid_pending_activation", { driverIgnoresSettle: true }, 4],
    ["captures on a decline", "decline_retry", { driverCapturesDecline: true }, 4],
  ] as const)("ends not_run when the driver %s", async (_name, scenario, switches, step) => {
    const { verdict } = await run(scenario, switches);
    expect(verdict.result).toBe("not_run");
    expect(codes(verdict)).toEqual(["outcome_failed"]);
    expect(finding(verdict, "outcome_failed")).toMatchObject({ run: "clean", step, field: "outcomes" });
    expect(finding(verdict, "outcome_failed")!.cause).toContain("ledger");
    expect(stepsOf(verdict, "control")).toEqual([]);
  });
});

describe("an outcome needs a new attempt (R32)", () => {
  it("ends not_run when the retry started no attempt for the settling outcome to act on", async () => {
    const { verdict } = await run("decline_retry", { retryStartsNone: true });
    expect(verdict.result).toBe("not_run");
    expect(codes(verdict)).toEqual(["outcome_failed"]);
    expect(finding(verdict, "outcome_failed")).toMatchObject({ run: "clean", step: 7 });
    expect(finding(verdict, "outcome_failed")!.observed).toContain("1 payment attempts against 1 at the previous outcome");
  });
});

describe("harm proven before a fault (R33)", () => {
  it("ranks a duplicate capture of the clean run above an outcome driver fault in the control run", async () => {
    const { verdict } = await run("paid_pending_activation", { doubleCapture: true, driverRejectsForControl: true });
    expect(verdict.result).toBe("failed");
    expect(codes(verdict)[0]).toBe("duplicate_capture");
    expect(finding(verdict, "duplicate_capture")).toMatchObject({ run: "clean" });
    expect(finding(verdict, "outcome_failed")).toMatchObject({ run: "control", step: 4 });
  });

  it("ranks harm proven earlier in the same run above the run's fault", async () => {
    const { verdict } = await run("paid_pending_activation", { doubleCapture: true, driverRejects: true });
    expect(verdict.result).toBe("failed");
    expect(codes(verdict)).toEqual(["duplicate_capture", "outcome_failed"]);
    expect(finding(verdict, "duplicate_capture")).toMatchObject({ run: "clean", step: 1 });
    expect(finding(verdict, "outcome_failed")).toMatchObject({ run: "clean", step: 4 });
  });

  it("ranks harm proven earlier in the clean run above a later stimulus check that ends not_run", async () => {
    const { verdict } = await run("decline_retry", { twoAttempts: true }, { proofFile: proofWith({ autoProgress: ["retry_payment"] }) });
    expect(verdict.result).toBe("failed");
    expect(codes(verdict)).toEqual(["second_attempt", "auto_progress_not_performed"]);
    expect(finding(verdict, "second_attempt")).toMatchObject({ run: "clean", step: 1 });
    expect(finding(verdict, "auto_progress_not_performed")).toMatchObject({ run: "clean", step: 7 });
  });

  it("keeps a fault ahead when no harm was proven before it", async () => {
    const { verdict } = await run("paid_pending_activation", { driverRejectsForControl: true });
    expect(verdict.result).toBe("not_run");
    // The stopped control run blocked nothing, which is reported after the fault.
    expect(codes(verdict)).toEqual(["outcome_failed", "control_not_applied"]);
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
