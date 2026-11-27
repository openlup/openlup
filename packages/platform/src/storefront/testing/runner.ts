import { parseStorefrontVerdict, type StorefrontProofFile, type StorefrontVerdict } from "../../lifecycle/index.js";
import { storefrontAnchor } from "../index.js";
import type { PageHandle, StorefrontAdapter, StorefrontObserver, StorefrontScenario } from "./contracts.js";
import { findingText, type FindingFacts } from "./findings.js";
import { storefrontScenarios } from "./scenarios.js";
import { utcInstant } from "./utcInstant.js";

type CommandMatcher = NonNullable<NonNullable<StorefrontAdapter["commands"]>["create"]>;
type VerdictStep = StorefrontVerdict["steps"][number];
type VerdictFinding = StorefrontVerdict["findings"][number];
type Ledger = NonNullable<VerdictStep["ledger"]>;
type ScenarioStep = StorefrontScenario["steps"][number];
type PageTarget = Parameters<PageHandle["find"]>[0];
type Measurement = NonNullable<Awaited<ReturnType<PageHandle["find"]>>>;
type RunName = "clean" | "control";
type Operation = "create" | "read";
type Progress = { readonly state: string; readonly offers: readonly string[] };

/**
 * Options of one scenario run. `page` is a `PageHandle` (from
 * `createPageHandle`); `commands` are the host proof kit's create and read
 * matchers and the command key header (default `idempotency-key`), each
 * overridden by the adapter's. `width` is required for `browser_ui` and must
 * equal `page.width()` when that is known. `clock.now()` returns integer epoch
 * milliseconds; it times the steps and gives `completedAt`. `runId` matches
 * `^[A-Za-z0-9-]{8,40}$`; the run subjects are
 * `storefront-<runId>-clean@example.test` and `…-control@example.test`.
 * `timeoutMs` (default 10,000) bounds each anchor wait; `quietMs` (default
 * 3,000) is the quiet window that ends every step. An observer with
 * `payableOrdersInDatabase` declares that its database is exclusive to this
 * run; the harness must not share it. `outcomes` is the outcome driver:
 * `capabilities` declares the outcome kinds it can produce, `produce` produces
 * one for the run's subject. `stopAt` (`checkout.<state>` for a state the
 * scenario expects) drives the clean run until that state is visible.
 */
type StorefrontRunOptions = {
  readonly scenario: string | StorefrontScenario;
  readonly page: PageHandle;
  readonly observer: StorefrontObserver;
  readonly tier: StorefrontVerdict["tier"];
  readonly profile: string;
  readonly width?: number;
  readonly channel?: StorefrontVerdict["channel"];
  readonly commands?: { readonly create?: CommandMatcher; readonly read?: CommandMatcher; readonly keyHeader?: string };
  readonly proofFile?: StorefrontProofFile;
  readonly adapter?: StorefrontAdapter;
  readonly build: Omit<StorefrontVerdict["build"], "source"> & { readonly source?: StorefrontVerdict["build"]["source"] };
  readonly harness: { readonly runnerVersion: string; readonly adapterDigest?: string };
  readonly runId: string;
  readonly clock: { now(): number };
  readonly timeoutMs?: number;
  readonly quietMs?: number;
  readonly outcomes?: {
    readonly capabilities: readonly string[];
    produce(outcome: string, context: { readonly subject: string }): Promise<void>;
  };
  readonly stopAt?: string;
};

/** A full run's verdict, or with `stopAt` the clean run's steps up to the state it stopped at. */
type StorefrontRunResult =
  | { kind: "verdict"; verdict: StorefrontVerdict }
  | { kind: "stopped"; stoppedAt: string; steps: StorefrontVerdict["steps"] };

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_QUIET_MS = 3_000;
const DEFAULT_KEY_HEADER = "idempotency-key";
const CATALOGUE_VERSION = 1;
const RUN_ID = /^[A-Za-z0-9-]{8,40}$/;
const NAME = /^[a-z][a-z0-9_]*$/;
const ERROR_CODE = /^([a-z][a-z0-9_]*): ([^\n]*?\.)(?: |$)/;
/** Anything URL-like in a fault message: a scheme and everything up to the next space, credentials and query included. */
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S*/giu;
const STEP_KINDS: ReadonlySet<string> = new Set(["arrange", "rearrange", "withhold", "act", "reload", "expect", "outcome"]);
const CONTROL_KINDS: ReadonlySet<string> = new Set(["none", "block_read", "omit_action", "other_policy"]);
/** The outcome kinds this runner knows. Each implies a payment attempt in the ledger after it is produced. */
const KNOWN_OUTCOMES: ReadonlySet<string> = new Set(["declined", "pending", "settled", "settled_after_pending", "activation_pending"]);
/** Outcomes that capture the payment: the ledger must then show more captures than at the end of the previous outcome. */
const SETTLING_OUTCOMES: ReadonlySet<string> = new Set(["settled", "settled_after_pending", "activation_pending"]);
/** The outcome that acts on an attempt an earlier outcome left pending; every other outcome acts on a new attempt. */
const ON_EARLIER_ATTEMPT = "settled_after_pending";
/** Ledger harm: once proven, a later fault of the harness does not hide it. */
const LEDGER_HARM: ReadonlySet<string> = new Set(["duplicate_order", "duplicate_hold", "duplicate_capture", "second_attempt", "forbidden_state_shown"]);
/** Faults of a run and the stimulus checks that end `not_run`; ranked below ledger harm the runs proved before them. */
const RUN_FAULTS: ReadonlySet<string> = new Set([
  "page_failed", "observer_failed:rejected", "arrange_failed", "outcome_failed:rejected", "outcome_failed:no_attempt", "outcome_failed:no_effect",
  "auto_progress_not_performed", "stimulus_not_applied", "stimulus_not_create",
]);
/** The changed-payload policies; an absent or unknown policy reads as the first. */
const POLICIES = ["refuse_changed", "update_in_place"] as const;
const STOP_PREFIX = "checkout.";
/** States that say the payment settled: the ledger must then show a capture and no payable order. */
const PAID_STATES: ReadonlySet<string> = new Set(["state:paid", "state:paid_pending_activation"]);
const DEFAULT_BUYER: Readonly<Record<string, string>> = {
  first_name: "Test", last_name: "Buyer", phone: "+15550100", address_line1: "1 Example Street", city: "Example City", postal_code: "00000",
};
const BUYER_FIELDS: ReadonlySet<string> = new Set(["first_name", "last_name", "phone", "address_line1", "address_line2", "city", "postal_code"]);

/** Where a code sits in the judgement order, and the result it gives when it is the first failing check. */
const JUDGEMENT: Readonly<Record<string, { readonly group: number; readonly rank: number; readonly result: StorefrontVerdict["result"] }>> = {
  tier_unreachable: { group: 0, rank: 0, result: "not_run" },
  // A page handle that cannot clear client state between the two buyers; admission is decided first.
  client_state_unisolated: { group: 0, rank: 1, result: "not_run" },
  page_failed: { group: 1, rank: 0, result: "not_run" },
  "observer_failed:rejected": { group: 1, rank: 0, result: "not_run" },
  arrange_failed: { group: 1, rank: 0, result: "not_run" },
  "outcome_failed:rejected": { group: 1, rank: 0, result: "not_run" },
  observer_subject_unseen: { group: 2, rank: 0, result: "not_run" },
  stimulus_not_create: { group: 3, rank: 0, result: "not_run" },
  stimulus_not_applied: { group: 3, rank: 0, result: "not_run" },
  // An outcome the driver reported but the ledger does not show never counts as stimulus.
  "outcome_failed:no_attempt": { group: 3, rank: 1, result: "not_run" },
  "outcome_failed:no_effect": { group: 3, rank: 1, result: "not_run" },
  // A declared auto-progress the page did not perform explains a missing outcome effect, so it ranks first.
  auto_progress_not_performed: { group: 3, rank: 0, result: "not_run" },
  duplicate_order: { group: 5, rank: 0, result: "failed" },
  duplicate_hold: { group: 5, rank: 0, result: "failed" },
  duplicate_capture: { group: 5, rank: 0, result: "failed" },
  second_attempt: { group: 5, rank: 0, result: "failed" },
  forbidden_state_shown: { group: 5, rank: 0, result: "failed" },
  order_outside_subject: { group: 5, rank: 1, result: "failed" },
  "observer_failed:unattributable": { group: 5, rank: 2, result: "not_run" },
  // The run stopped before its progress and control were exercised, so it proves nothing either way (missing
  // evidence, never a pass); a ledger violation observed before the stop is already proof of harm and outranks it.
  request_budget_exceeded: { group: 5, rank: 3, result: "not_run" },
  adapter_matcher_unmatched: { group: 6, rank: 0, result: "not_run" },
  "adapter_anchor_missing:action": { group: 6, rank: 0, result: "not_run" },
  "adapter_anchor_missing:field": { group: 6, rank: 0, result: "not_run" },
  anchor_hidden: { group: 6, rank: 0, result: "not_run" },
  progress_not_reached: { group: 7, rank: 0, result: "failed" },
  policy_mismatch: { group: 7, rank: 0, result: "failed" },
  "adapter_anchor_missing:state": { group: 7, rank: 0, result: "not_run" },
  control_not_applied: { group: 8, rank: 0, result: "not_run" },
  vacuous_progress: { group: 8, rank: 1, result: "vacuous" },
  auto_progress_undeclared: { group: 8, rank: 1, result: "not_run" },
};

function refuse(code: string, observed: string, cause: string, fix: string): TypeError {
  return new TypeError(`${code}: ${observed} Cause: ${cause} Fix: ${fix} Recheck: call runStorefrontScenario again with the corrected options.`);
}

function invalid(observed: string, fix: string): TypeError {
  return refuse("storefront_run_input_invalid", observed, "the runner drives nothing until every option is valid.", fix);
}

function nonNegative(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw invalid(`${name} is ${String(value)}.`, `Pass ${name} as a finite number of milliseconds, 0 or more.`);
  return value;
}

function resolveScenario(scenario: string | StorefrontScenario): StorefrontScenario {
  if (typeof scenario === "string") {
    const known = storefrontScenarios.find((entry) => entry.id === scenario);
    if (known === undefined) {
      throw refuse("storefront_scenario_unknown", `No scenario has the id ${JSON.stringify(scenario)}.`,
        "the runner runs the scenarios of storefrontScenarios by id.",
        `Pass one of ${storefrontScenarios.map((entry) => entry.id).join(", ")}.`);
    }
    return known;
  }
  if (typeof scenario !== "object" || scenario === null || typeof scenario.id !== "string" || !NAME.test(scenario.id)) {
    throw refuse("storefront_scenario_unknown", "The scenario is neither a known id nor a scenario object with an id.",
      "the runner runs a scenario by id or a scenario object.", "Pass a scenario id from storefrontScenarios.");
  }
  const problem = scenarioProblem(scenario);
  if (problem !== null) throw invalid(`Scenario object ${scenario.id}: ${problem}.`, "Shape the scenario object as the entries of storefrontScenarios are shaped.");
  return scenario;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isName = (value: unknown): value is string => typeof value === "string" && NAME.test(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isNames = (value: unknown): boolean => Array.isArray(value) && value.every(isName);
/** `forbiddenStates`: `{ control: names, clean: { ruledOut: names, afterShowing?: { state, regressions: names } } }`. */
function isForbiddenStates(value: unknown): boolean {
  if (!isRecord(value) || !isNames(value.control) || !isRecord(value.clean) || !isNames(value.clean.ruledOut)) return false;
  const after = value.clean.afterShowing;
  return after === undefined || (isRecord(after) && isName(after.state) && isNames(after.regressions));
}

/** The first way a scenario object is malformed, or `null`. Nothing about it is trusted before this check. */
function scenarioProblem(scenario: StorefrontScenario): string | null {
  const value = scenario as unknown as Record<string, unknown>;
  if (typeof value.title !== "string" || !isName(value.purchaseMode)) return "title must be a string and purchaseMode a name";
  if (!isRecord(value.requires) || !Array.isArray(value.requires.outcomes) || !value.requires.outcomes.every(isName)) return "requires.outcomes must be a list of names";
  if (!isRecord(value.budget) || !isCount(value.budget.creates)) return "budget.creates must be an integer, 0 or more";
  if (!isRecord(value.text) || !["stimulus", "safety", "progress", "control"].every((key) => typeof (value.text as Record<string, unknown>)[key] === "string")) return "text must hold the four sentences";
  if (!Array.isArray(value.steps) || value.steps.length === 0) return "steps must be a non-empty list";
  const steps = value.steps as unknown[];
  const isProgress = (progress: unknown) => isRecord(progress) && isName(progress.state) && Array.isArray(progress.offers) && progress.offers.every(isName);
  for (const [index, step] of steps.entries()) {
    if (!isRecord(step) || typeof step.kind !== "string" || !STEP_KINDS.has(step.kind)) return `step ${index} must have one of the kinds ${[...STEP_KINDS].join(", ")}`;
    if (step.kind === "act" && (!isName(step.action) || (step.twice !== undefined && typeof step.twice !== "boolean"))) return `step ${index} (act) needs an action name`;
    if (step.kind === "expect" && (!isProgress(step) || (step.byPolicy !== undefined && (!isRecord(step.byPolicy) || !Object.values(step.byPolicy).every(isProgress))))) {
      return `step ${index} (expect) needs a state name and a list of offered actions, also per policy`;
    }
    if (step.kind === "rearrange" && step.edit !== undefined && !isName(step.edit)) return `step ${index} (rearrange) edit must be a field name`;
    if (step.kind === "outcome" && !isName(step.outcome)) return `step ${index} (outcome) needs an outcome name`;
    if (step.kind === "outcome" && !(value.requires.outcomes as unknown[]).includes(step.outcome)) return `step ${index} (outcome) names ${String(step.outcome)}, which requires.outcomes does not list`;
  }
  const safety = value.safety;
  if (!isRecord(safety)) return "safety must be an object";
  const isStepIndex = (index: unknown) => isCount(index) && index < steps.length;
  for (const [rule, limit] of Object.entries(safety)) {
    if (limit === undefined) continue;
    const expected = rule === "attemptsPerDecline" ? "a boolean" : rule === "noAttemptAfter" ? "a step index"
      : rule === "forbiddenStates" ? "{ control: state names, clean: { ruledOut: state names, afterShowing?: { state, regressions: state names } } }" : "an integer, 0 or more";
    const valid = rule === "attemptsPerDecline" ? typeof limit === "boolean" : rule === "noAttemptAfter" ? isStepIndex(limit)
      : rule === "forbiddenStates" ? isForbiddenStates(limit) : isCount(limit);
    if (!valid) return `safety.${rule} must be ${expected}`;
  }
  const control = value.control;
  if (!isRecord(control) || typeof control.kind !== "string" || !CONTROL_KINDS.has(control.kind)) return `control.kind must be one of ${[...CONTROL_KINDS].join(", ")}`;
  if (control.negates !== null && !isName(control.negates)) return "control.negates must be a state name or null";
  if (control.outcomes !== undefined && control.outcomes !== "kept" && control.outcomes !== "skipped") return "control.outcomes must be kept or skipped";
  if (control.kind === "block_read") {
    if (!Array.isArray(control.commands) || control.commands.length === 0 || !control.commands.every((command) => command === "create" || command === "read")) return "control.commands must list create or read";
    if (!isStepIndex(control.from)) return "control.from must be the index of one of its steps";
    if (control.negates === null) return "a block_read control must negate a state";
  }
  if (control.kind === "omit_action") {
    if (!steps.some((step) => isRecord(step) && step.kind === "act" && step.action === control.action)) return "an omit_action control must name an action one of its act steps performs";
    if (control.negates === null) return "an omit_action control must negate a state";
  }
  if (control.kind === "other_policy") {
    const byPolicy = steps.find((step): step is { byPolicy: Record<string, unknown> } => isRecord(step) && step.kind === "expect" && isRecord(step.byPolicy));
    if (byPolicy === undefined || !POLICIES.every((policy) => Object.hasOwn(byPolicy.byPolicy, policy))) return `an other_policy control needs an expect step with byPolicy for ${POLICIES.join(" and ")}`;
  }
  return null;
}

function matches(matcher: CommandMatcher, request: { method: string; path: string }): boolean {
  if (typeof matcher === "function") {
    try {
      return matcher({ method: request.method, path: request.path }) === true;
    } catch {
      return false;
    }
  }
  return matcher.method.toUpperCase() === request.method.toUpperCase() && matcher.path === request.path;
}

function visible(measurement: Measurement): boolean {
  return measurement.width > 0 && measurement.height > 0 && measurement.insideScrollArea
    && !measurement.hidden && !measurement.transparent && !measurement.coveredAtCentre;
}

function whyHidden(measurement: Measurement): string {
  const reasons = [
    measurement.width > 0 && measurement.height > 0 ? null : "zero size",
    measurement.insideScrollArea ? null : "out of the buyer's reach",
    measurement.hidden ? "hidden" : null,
    measurement.transparent ? "transparent" : null,
    measurement.coveredAtCentre ? "covered at its centre" : null,
  ].filter((reason) => reason !== null);
  return reasons.join(", ");
}

/** A fault's code and first sentence when it carries one, with every URL replaced by `<url>`, else its name; never a body, a credential or a query. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const coded = ERROR_CODE.exec(error.message.replace(URL_LIKE, "<url>"));
    if (coded !== null) return `${coded[1]}: ${coded[2]}`.slice(0, 300);
    return error.name;
  }
  return typeof error;
}

function describeStep(step: ScenarioStep, policy: string): string {
  if (step.kind === "act") return `act ${step.action}${step.twice === true ? " twice" : ""}`;
  if (step.kind === "expect") return `expect ${progressOf(step, policy).state}`;
  if (step.kind === "outcome") return `outcome ${step.outcome}`;
  if (step.kind === "rearrange" && step.edit !== undefined) return `rearrange editing ${step.edit}`;
  return step.kind;
}

/** The progress an expect step asks for under a changed-payload policy. */
function progressOf(step: ScenarioStep & { kind: "expect" }, policy: string): Progress {
  const byPolicy = step.byPolicy;
  return byPolicy !== undefined && Object.hasOwn(byPolicy, policy) ? byPolicy[policy]! : step;
}

/**
 * The control as run. `start` is the first step it affects (`Infinity` for
 * none); `blocked` the commands blocked from there; `omit` the act the control
 * run omits; `skipOutcomesFrom` the first step whose outcome the control run
 * skips; `cleanSkip` an act neither run performs because the UI does it by
 * itself.
 */
type EffectiveControl = {
  readonly kind: string;
  readonly action?: string;
  readonly negates: string | null;
  readonly start: number;
  readonly blocked: readonly Operation[];
  readonly omit: number | null;
  readonly skipOutcomesFrom: number;
  readonly cleanSkip: number | null;
};

function effectiveControl(scenario: StorefrontScenario, policy: string, autoProgress: readonly string[]): EffectiveControl {
  const control = scenario.control;
  const none = Number.POSITIVE_INFINITY;
  const skipped = control.outcomes === "skipped";
  if (control.kind === "block_read") {
    const from = control.from ?? 0;
    return { kind: "block_read", negates: control.negates, start: from, blocked: control.commands ?? [], omit: null, skipOutcomesFrom: skipped ? from : none, cleanSkip: null };
  }
  if (control.kind === "omit_action") {
    const action = control.action ?? "";
    const at = scenario.steps.findIndex((step) => step.kind === "act" && step.action === action);
    // A UI that performs the action by itself, as declared: neither run performs it, and the control blocks status
    // reads from the step before it, so a state the server reported is told from one shown without a read.
    if (autoProgress.includes(action)) {
      return { kind: "block_read", negates: control.negates, start: Math.max(0, at - 1), blocked: ["read"], omit: null, skipOutcomesFrom: at + 1, cleanSkip: at };
    }
    return { kind: "omit_action", action, negates: control.negates, start: at, blocked: [], omit: at, skipOutcomesFrom: skipped ? at + 1 : none, cleanSkip: null };
  }
  if (control.kind === "other_policy") {
    const at = scenario.steps.findIndex((step) => step.kind === "expect" && step.byPolicy !== undefined);
    const step = scenario.steps[at] as ScenarioStep & { kind: "expect" };
    const other = POLICIES.find((candidate) => candidate !== policy) ?? POLICIES[0];
    return { kind: "other_policy", negates: progressOf(step, other).state, start: at, blocked: [], omit: null, skipOutcomesFrom: none, cleanSkip: null };
  }
  return { kind: control.kind, negates: control.negates, start: none, blocked: [], omit: null, skipOutcomesFrom: none, cleanSkip: null };
}

/** The adapter's `actions`, keyed by full anchor name: a state name becomes `state:<name>`, any other `action:<name>`. */
function anchorLocators(actions: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const locators: Record<string, string> = {};
  for (const [name, locator] of Object.entries(actions ?? {})) {
    locators[Object.hasOwn(storefrontAnchor.state, name) ? `state:${name}` : `action:${name}`] = locator;
  }
  return locators;
}

type Judged = {
  readonly group: number;
  readonly rank: number;
  readonly result: StorefrontVerdict["result"];
  readonly order: number;
  readonly key: string;
  readonly finding: VerdictFinding;
};

/**
 * Ledger harm a run proved before a fault outranks the fault: harm in the
 * clean run before a fault in the control run, or harm at or before the
 * fault's step in the same run. The fault then ranks right below the ledger
 * checks, still above the budget, so the result is `failed`.
 */
function rankFaultsBelowProvenHarm(judged: readonly Judged[]): Judged[] {
  const harm = judged.filter((entry) => LEDGER_HARM.has(entry.finding.code));
  const provenBefore = (fault: VerdictFinding) => harm.some(({ finding }) => (finding.run === "clean" && fault.run === "control")
    || (finding.run === fault.run && finding.step !== null && fault.step !== null && finding.step <= fault.step));
  return judged.map((entry) => RUN_FAULTS.has(entry.key) && provenBefore(entry.finding) ? { ...entry, group: 5, rank: 2 } : entry);
}

type RunRecord = {
  readonly run: RunName;
  readonly steps: VerdictStep[];
  stopped: boolean;
  readonly matched: Record<Operation, number>;
  creates: number;
  blocked: number;
  blockedSetSeen: number;
  readonly createSteps: Set<number>;
  databaseBefore: number | null;
  databaseAfter: number | null;
  /** Declines the outcome driver produced up to each recorded step, by step index. */
  readonly declines: Map<number, number>;
  /** With `stopAt`, the index of the step after which the state was visible. */
  stoppedAt: number | null;
};

/**
 * Runs one storefront scenario and resolves `{ kind: "verdict", verdict }`, a
 * format-1 verdict that `parseStorefrontVerdict` accepts, or with `stopAt`
 * `{ kind: "stopped", stoppedAt, steps }`.
 *
 * The clean run reads the subject's ledger (an earlier order ends `not_run`),
 * installs one interceptor that classifies requests by the create and read
 * matchers, records each command's key reuse (key values are compared in
 * memory, never stored) and applies the armed withhold or hold, then runs the
 * steps. Every step ends only when the page has settled: every request the
 * interceptor saw finished and `quietMs` passed with no new request. Then the
 * runner reads the ledger, the visible anchors and the path. After the last
 * step a settle window waits once more and reads them again. The control run
 * repeats the steps under the other subject with the scenario's control: a
 * `block_read` control blocks every request of its commands from its step; an
 * `omit_action` control omits its action and, when the scenario says so, the
 * outcomes after it; an `other_policy` control changes nothing and must not
 * show the progress of the changed-payload policy the proof file does not
 * declare. A `safety_only` scenario has no control run. When the UI performs
 * the omitted action by itself, as the effective `autoProgress` declares,
 * neither run performs it and the control becomes a `block_read` of status
 * reads from the step before it, with the outcomes after it skipped; when the
 * clean run still offers that action at the end of the following step and the
 * next expected state is not shown, the declaration is wrong:
 * `auto_progress_not_performed` (`not_run`).
 *
 * Client state: the clean and control runs are two buyers on one page. Each
 * run calls `page.clearClientState()` after its ledger read (and the
 * exclusive database's count) and before its interceptor, so it starts with no
 * cookies, local storage or session storage of the store's origin; a
 * rejection is `page_failed` of that run (step `null`). A handle without the
 * member cannot isolate the buyers: an admitted scenario with a control run
 * then ends `not_run` with `client_state_unisolated` only, before any page,
 * observer or driver call; a `safety_only` scenario runs as before.
 *
 * Outcomes: an `outcome` step asks the `outcomes` driver for one outcome
 * (`declined`, `pending`, `settled`, `settled_after_pending`,
 * `activation_pending`). A scenario runs only when every outcome in its
 * `requires.outcomes` is one this runner knows and the driver declares; else
 * it ends `not_run` with `tier_unreachable` naming each missing outcome before
 * any page, observer or driver call. Tier names do not decide admission.
 * Every capability must be a name; one the runner does not know is ignored.
 * Each outcome has a ledger effect, compared with the ledger at the end of the
 * previous outcome step (zero before the first): every outcome but
 * `settled_after_pending` acts on a new attempt (more attempts), a settling
 * outcome (`settled`, `settled_after_pending`, `activation_pending`) adds a
 * capture, and `declined` or `pending` adds none. A rejected `produce`, or an
 * outcome whose effect the ledger does not show, is `outcome_failed` and stops
 * the run.
 *
 * Judgement, first failing group decides: 0 admitted, then client state
 * isolated; 1 page, observer,
 * arrangement and outcome driver worked; 2 no order before the arrangement and
 * one after the first matched create; 3 the first order appeared in a step with
 * a matched create, every withhold applied, every outcome shows its ledger
 * effect and declared auto-progress was performed; 4 ledger safety in both
 * runs and settle windows (payable orders, orders holding stock, attempts, captures, no attempt after its step, attempts per
 * decline, forbidden states per run; a paid state needs a capture
 * and no payable order) and, for an exclusive database, no payable order
 * outside the subjects; 5 the create budget kept (a run over it stopped before
 * proving anything, but a violation it already caused stands); 6 each matcher
 * used matched and each needed anchor resolved and was visible; 7 the clean run
 * reached its expected state (the other policy's state is `policy_mismatch`);
 * 8 a `block_read` control blocked a request and the negated state was not
 * reached, judged over every recorded control step even when the control run
 * stopped; under an `omit_action` control a negated state reached after a
 * status read is `auto_progress_undeclared`. Codes 0–3, 5 and 6 end `not_run`,
 * as do `control_not_applied` and `auto_progress_undeclared`; a harness fault
 * is never `failed` or `passed`; a ledger violation is
 * `failed`; progress under the control is `vacuous`. Ledger harm a run proved
 * before a fault or a stimulus check that ends `not_run` (in the clean run
 * before one in the control run, or at or before its step in the same run)
 * outranks it, so the result is
 * `failed`. Without a finding the result is `passed`, or `safety_only` for a
 * scenario without a control.
 *
 * Invalid options (an unknown scenario, a malformed `runId`, a missing or
 * mismatched `width`, a clock outside integer milliseconds 0 to the end of the
 * year 9999, a malformed outcome driver or a capability that is not a name) reject with a `TypeError` starting
 * `storefront_scenario_unknown` or `storefront_run_input_invalid`, and nothing
 * is driven, as does a malformed scenario object; a `stopAt` that is not
 * `checkout.<state>` for a state the scenario expects rejects
 * `storefront_stop_state_unknown`. With `stopAt` the runner runs the clean
 * steps until that state is visible, removes its interceptor and leaves the
 * page there: no control run and no verdict; a state not reached rejects
 * `storefront_stop_state_unreached` naming the last step, as does a scenario
 * that is not admitted or a page handle without `clearClientState`, before any
 * call. An arrangement that
 * fails under a control is the control's effect: the remaining steps are
 * skipped and the settle window still samples the page. Anchors and the ledger
 * are sampled after each step settles and in the settle window, so a state
 * shown only inside a step is not seen. A fault's text keeps its code and
 * first sentence with every URL replaced.
 *
 * @experimental
 */
export async function runStorefrontScenario(options: StorefrontRunOptions): Promise<StorefrontRunResult> {
  const scenario = resolveScenario(options.scenario);
  const { page, observer, adapter, proofFile, clock, outcomes } = options;
  if (typeof options.runId !== "string" || !RUN_ID.test(options.runId)) {
    throw invalid(`runId is ${JSON.stringify(String(options.runId)).slice(0, 60)}.`, "Pass a runId of 8 to 40 letters, digits and hyphens, new for every run.");
  }
  const channel = options.channel ?? "browser_ui";
  const timeoutMs = nonNegative(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  const quietMs = nonNegative(options.quietMs, DEFAULT_QUIET_MS, "quietMs");
  if (channel === "browser_ui" && (typeof options.width !== "number" || !Number.isSafeInteger(options.width) || options.width <= 0)) {
    throw invalid(`width is ${String(options.width)} for the browser_ui channel.`, "Pass the page's viewport width in CSS pixels as a positive integer.");
  }
  if (outcomes !== undefined && (!isRecord(outcomes) || !Array.isArray(outcomes.capabilities) || typeof outcomes.produce !== "function")) {
    throw invalid("outcomes is not an outcome driver.", "Pass outcomes as { capabilities: outcome kinds the driver can produce, produce(outcome, { subject }) }, or leave it out.");
  }
  // A capability is recorded in the verdict, so one that is not a name is refused; a name the runner does not know is ignored.
  const badCapability = outcomes?.capabilities.findIndex((capability) => !isName(capability)) ?? -1;
  if (badCapability >= 0) {
    throw refuse("storefront_run_input_invalid", `outcomes.capabilities[${badCapability}] is ${JSON.stringify(outcomes!.capabilities[badCapability]) ?? String(outcomes!.capabilities[badCapability])}, not a name matching ^[a-z][a-z0-9_]*$.`,
      "the runner records every declared capability in the verdict, so each must be a name.", "Declare each capability as an outcome kind name, such as settled.");
  }
  const policy: string = proofFile?.changedPayloadPolicy === "update_in_place" ? "update_in_place" : POLICIES[0];
  const autoProgress = [...(adapter?.autoProgress ?? proofFile?.autoProgress ?? [])];
  const control = effectiveControl(scenario, policy, autoProgress);
  const expectSteps = scenario.steps.filter((step): step is ScenarioStep & { kind: "expect" } => step.kind === "expect");
  // With declared auto-progress, the state the next expect after the skipped action asks for.
  const nextAfterSkip = control.cleanSkip === null ? undefined
    : scenario.steps.slice(control.cleanSkip + 1).find((step): step is ScenarioStep & { kind: "expect" } => step.kind === "expect");
  const nextProgress = nextAfterSkip === undefined ? null : progressOf(nextAfterSkip, policy).state;
  const stopState = options.stopAt === undefined ? undefined : stopStateOf(options.stopAt, expectSteps);
  const create = adapter?.commands?.create ?? options.commands?.create;
  const read = adapter?.commands?.read ?? options.commands?.read;
  const keyHeader = adapter?.commands?.keyHeader ?? options.commands?.keyHeader ?? DEFAULT_KEY_HEADER;
  if (create === undefined) throw invalid("No create matcher is given.", "Pass commands.create, or give the adapter commands.create.");
  if (control.blocked.includes("read") && read === undefined) throw invalid(`Scenario ${scenario.id} blocks reads but no read matcher is given.`, "Pass commands.read, or give the adapter commands.read.");
  const started = clock.now();
  utcInstant(started);
  const recheck = (adapter?.recheck ?? proofFile?.recheck)?.replaceAll("{scenario}", scenario.id)
    ?? `Run scenario ${scenario.id} again with the same harness.`;
  const adapterFields = adapter === undefined ? [] : Object.keys(adapter).filter((key) => (adapter as Record<string, unknown>)[key] !== undefined).sort();
  const declared = [...(outcomes?.capabilities ?? [])];
  const verdictOf = (rest: Pick<StorefrontVerdict, "result" | "stimulus" | "steps" | "findings" | "durations" | "completedAt"> & { applied: boolean }): StorefrontVerdict => ({
    formatVersion: 1,
    runId: options.runId,
    completedAt: rest.completedAt,
    scenario: scenario.id,
    tier: options.tier,
    profile: options.profile,
    channel,
    ...(options.width === undefined ? {} : { width: options.width }),
    result: rest.result,
    control: { kind: control.kind, ...(control.action === undefined ? {} : { action: control.action }), negates: control.negates, applied: rest.applied },
    stimulus: rest.stimulus,
    steps: rest.steps,
    findings: rest.findings,
    build: { source: options.build.source ?? "claimed", packages: options.build.packages, clients: options.build.clients, proofFile: options.build.proofFile },
    harness: {
      runnerVersion: options.harness.runnerVersion,
      catalogueVersion: CATALOGUE_VERSION,
      adapter: adapter === undefined
        ? { kind: "default", fields: [], digest: null }
        : { kind: "custom", fields: adapterFields, digest: options.harness.adapterDigest ?? null },
      autoProgress,
      observer: observer.kind,
      declaredOutcomes: [...declared].sort(),
    },
    durations: rest.durations,
  });
  // Every option that reaches the verdict is checked by the verdict's own parser before anything is driven.
  const probe = parseStorefrontVerdict(JSON.stringify(verdictOf({
    result: "not_run", stimulus: {}, steps: [], findings: [], durations: { totalMs: 0, byPhase: {} }, completedAt: utcInstant(started), applied: false,
  })));
  if (!probe.ok) throw invalid(`The options give a verdict the parser refuses: ${probe.refusal.observed}`, probe.refusal.fix);

  const judged: Judged[] = [];
  const add = (code: string, cause: string, run: RunName | null, step: number | null, facts: FindingFacts, field?: string) => {
    const text = findingText(code, cause, facts);
    const place = JUDGEMENT[`${code}:${cause}`] ?? JUDGEMENT[code]!;
    judged.push({
      ...place,
      order: judged.length,
      key: JUDGEMENT[`${code}:${cause}`] === undefined ? code : `${code}:${cause}`,
      finding: { code, run, step, ...(field === undefined ? {} : { field }), observed: text.observed, cause: text.cause, fix: text.fix, recheck },
    });
  };
  const finish = (rest: Omit<Parameters<typeof verdictOf>[0], "result" | "findings" | "completedAt">) => {
    const ended = clock.now();
    const completedAt = utcInstant(ended);
    const ordered = rankFaultsBelowProvenHarm(judged).sort((a, b) => a.group - b.group || a.rank - b.rank || a.order - b.order);
    const result = ordered[0]?.result ?? (control.kind === "none" ? "safety_only" : "passed");
    const verdict = verdictOf({ ...rest, result, findings: ordered.map((entry) => entry.finding), completedAt,
      durations: { ...rest.durations, totalMs: Math.max(0, Math.round(ended - started)) } });
    const parsed = parseStorefrontVerdict(JSON.stringify(verdict));
    if (!parsed.ok) throw new Error(`storefront runner produced a verdict its parser refuses: ${parsed.refusal.observed}`);
    return { kind: "verdict" as const, verdict };
  };

  // Admission: a required outcome this runner does not know or the driver does not declare ends the scenario before
  // any page, observer or driver call. The tier is not consulted.
  const missing = scenario.requires.outcomes.filter((outcome) => !KNOWN_OUTCOMES.has(outcome) || !declared.includes(outcome));
  if (missing.length > 0) {
    if (stopState !== undefined) {
      throw refuse("storefront_stop_state_unreached", `Scenario ${scenario.id} was not admitted: the outcome driver does not declare ${missing.join(", ")}.`,
        "a scenario runs only where every outcome it requires can be produced.", "Run it with an outcome driver that declares these outcomes.");
    }
    add("tier_unreachable", "only", null, null, { at: `Scenario ${scenario.id}`, detail: missing.join(", ") });
    return finish({ stimulus: {}, steps: [], durations: { totalMs: 0, byPhase: {} }, applied: false });
  }
  // Isolation: the clean and control runs are two buyers on one page. A handle that cannot clear the browser's client
  // state between them ends every scenario with a control run before any page, observer or driver call; one buyer
  // alone (a safety-only scenario) has nothing to isolate. Stop-at refuses it, as it refuses a scenario not admitted.
  const isolates = typeof page.clearClientState === "function";
  if (!isolates && stopState !== undefined) {
    throw refuse("storefront_stop_state_unreached", "The page handle has no clearClientState.",
      "the page handle cannot clear client state, so the stopped page could show an earlier buyer's state.",
      findingText("client_state_unisolated", "only", { at: `Scenario ${scenario.id}` }).fix);
  }
  if (!isolates && control.kind !== "none") {
    add("client_state_unisolated", "only", null, null, { at: `Scenario ${scenario.id}` });
    return finish({ stimulus: {}, steps: [], durations: { totalMs: 0, byPhase: {} }, applied: false });
  }
  const known = page.width();
  if (channel === "browser_ui" && known !== null && known !== options.width) {
    throw invalid(`width is ${String(options.width)} but the page's viewport is ${known} CSS pixels wide.`, "Pass the width the page is driven at.");
  }

  const selectionEntry = adapter?.routes?.selectionEntry ?? proofFile?.routes?.selectionEntry;
  const entryPath = selectionEntry !== undefined && Object.hasOwn(selectionEntry, scenario.purchaseMode) ? selectionEntry[scenario.purchaseMode] : undefined;
  const locators = anchorLocators(adapter?.actions);
  const targetOf = (group: "action" | "state" | "field", name: string): PageTarget => {
    const locator = group === "field" ? undefined : locators[`${group}:${name}`];
    return locator === undefined ? { attribute: group, value: name } : { locator };
  };
  const fieldOf = (group: "action" | "state", name: string) => locators[`${group}:${name}`] === undefined ? undefined : "actions";
  const byPhase: Record<string, number> = {};
  const elapsed = (from: number) => Math.max(0, Math.round(clock.now() - from));
  const describe = (index: number, run: RunName) => index === scenario.steps.length
    ? `The settle window of the ${run} run`
    : `Step ${index} (${describeStep(scenario.steps[index]!, policy)}) of the ${run} run`;

  const runOnce = async (run: RunName): Promise<RunRecord> => {
    const subject = `storefront-${options.runId}-${run}@example.test`;
    const buyer: Record<string, string | boolean> = { email: subject };
    for (const [field, value] of Object.entries({ ...DEFAULT_BUYER, ...proofFile?.buyer })) {
      if (BUYER_FIELDS.has(field) && typeof value === "string") buyer[field] = value;
    }
    buyer.terms_accepted = true;
    const record: RunRecord = {
      run, steps: [], stopped: false, matched: { create: 0, read: 0 }, creates: 0, blocked: 0, blockedSetSeen: 0,
      createSteps: new Set(), databaseBefore: null, databaseAfter: null, declines: new Map(), stoppedAt: null,
    };
    let stepIndex = -1;
    let commands: VerdictStep["commands"] = [];
    let ordinal = 0;
    let declines = 0;
    // The ledger at the end of the previous outcome step (none yet: zero).
    let beforeOutcome = { attempts: 0, captures: 0 };
    const keys = new Map<string, number>();
    let withhold: "idle" | "armed" | "applied" = "idle";
    let hold: { used: boolean; released: Promise<void> } | null = null;
    let exceededAt: number | null = null;
    const at = (index: number) => describe(index, run);
    const underControl = (index: number) => run === "control" && index >= control.start;
    const checksAnchors = (index: number) => !underControl(index);
    // Under the control a failed arrangement is the control's effect, not a fault: the rest of the steps is skipped
    // and the settle window still samples the page. Before the control starts it stops the run.
    let skipToSettle = false;
    const stop = (index: number) => {
      if (underControl(index)) skipToSettle = true;
      else record.stopped = true;
    };

    const fault = (code: "page_failed" | "observer_failed" | "arrange_failed", index: number | null, error: unknown) => {
      add(code, code === "observer_failed" ? "rejected" : "only", run, index, { at: index === null ? `Before the arrangement of the ${run} run` : at(index), detail: describeError(error) });
      record.stopped = true;
    };
    const fromObserver = async <T>(index: number | null, call: () => Promise<T>): Promise<T | null> => {
      try {
        return await call();
      } catch (error) {
        fault("observer_failed", index, error);
        return null;
      }
    };

    const decide = async (request: { method: string; path: string; header(name: string): string | null }) => {
      const operation: Operation | null = matches(create, request) ? "create" : read !== undefined && matches(read, request) ? "read" : null;
      if (operation === null) return "pass" as const;
      const value = request.header(keyHeader);
      const present = value !== null && value !== "";
      const current = ordinal;
      ordinal += 1;
      let sameAs: number | null = null;
      if (present) {
        const first = keys.get(value);
        if (first === undefined) keys.set(value, current);
        else sameAs = first;
      }
      commands.push({ operation, ordinal: current, key: { present, sameAs } });
      record.matched[operation] += 1;
      const blocking = stepIndex >= control.start && control.blocked.includes(operation);
      if (blocking) record.blockedSetSeen += 1;
      if (operation === "create") {
        record.creates += 1;
        record.createSteps.add(stepIndex);
        if (record.creates > scenario.budget.creates) {
          exceededAt ??= stepIndex;
          return "block" as const;
        }
      }
      if (run === "control" && blocking) {
        record.blocked += 1;
        return "block" as const;
      }
      if (operation === "create" && withhold === "armed") {
        withhold = "applied";
        return "withhold" as const;
      }
      if (operation === "create" && hold !== null && !hold.used) {
        hold.used = true;
        await hold.released;
      }
      return "pass" as const;
    };

    const seenNow = async () => (await page.anchors(locators)).join(", ");
    /** Finds an action and, where anchors are checked, records a finding when it is missing or not visible; `true` when it is visible. */
    const actionShown = async (name: string, index: number): Promise<boolean> => {
      const found = await page.find(targetOf("action", name), { timeoutMs });
      if (found !== null && visible(found)) return true;
      if (!checksAnchors(index)) return false;
      if (found === null) add("adapter_anchor_missing", "action", run, index, { at: at(index), name: `action:${name}`, seen: await seenNow() }, fieldOf("action", name));
      else add("anchor_hidden", "only", run, index, { at: at(index), name: `action:${name}`, detail: whyHidden(found) }, fieldOf("action", name));
      return false;
    };
    const perform = async (name: string, index: number): Promise<boolean> => {
      if (!(await actionShown(name, index))) return false;
      if (await page.perform(targetOf("action", name), { timeoutMs })) return true;
      if (checksAnchors(index)) {
        add("adapter_anchor_missing", "action", run, index, { at: at(index), name: `action:${name}`, detail: "disabled", seen: await seenNow() }, fieldOf("action", name));
      }
      return false;
    };
    const fillDetails = async (index: number, edit: string | undefined): Promise<boolean> => {
      for (const [field, value] of Object.entries(buyer)) {
        const target = targetOf("field", field);
        // The e-mail carries the subject and must resolve; the other fields are filled where the form has them.
        const found = await page.find(target, { timeoutMs: field === "email" ? timeoutMs : 0 });
        if (found === null) {
          if (field !== "email") continue;
          if (checksAnchors(index)) add("adapter_anchor_missing", "field", run, index, { at: at(index), name: `field:${field}`, seen: await seenNow() });
          return false;
        }
        const typed = field === edit && typeof value === "string" ? `${value} Changed` : value;
        if (!(await page.fill(target, typed, { timeoutMs })) && field === "email") {
          if (checksAnchors(index)) add("adapter_anchor_missing", "field", run, index, { at: at(index), name: `field:${field}`, seen: await seenNow() });
          return false;
        }
      }
      return true;
    };
    const defaultArrange = async (index: number, edit: string | undefined): Promise<boolean> => {
      if (entryPath === undefined) {
        add("arrange_failed", "only", run, index, { at: at(index), detail: `no selection entry is declared for ${scenario.purchaseMode} and the adapter has no arrange function` }, "routes.selectionEntry");
        return false;
      }
      await page.navigate(entryPath);
      return await perform("proceed_to_checkout", index) && await fillDetails(index, edit);
    };

    const before = await fromObserver(null, () => observer.ledger(subject));
    if (before === null) return record;
    if (before.orders > 0) {
      add("observer_subject_unseen", "order_before_arrange", run, null, { at: `Before the arrangement of the ${run} run`, count: before.orders });
      record.stopped = true;
      return record;
    }
    if (observer.payableOrdersInDatabase !== undefined) {
      const counted = await fromObserver(null, () => observer.payableOrdersInDatabase!());
      if (counted === null) return record;
      record.databaseBefore = counted;
    }
    // Each run starts as a new buyer: no cookies, local or session storage of the store's origin.
    if (isolates) {
      try {
        await page.clearClientState!();
      } catch (error) {
        fault("page_failed", null, error);
        return record;
      }
    }

    let remove: (() => Promise<void>) | null = null;
    try {
      try {
        remove = await page.intercept(decide);
      } catch (error) {
        fault("page_failed", null, error);
        return record;
      }
      for (let index = 0; index <= scenario.steps.length && !record.stopped; index += 1) {
        const step = scenario.steps[index];
        stepIndex = index;
        commands = [];
        const begin = clock.now();
        let completed = false;
        let expected: Measurement | null = null;
        let progress: Progress | null = null;
        let produced: string | null = null;
        // An act the UI performs by itself (both runs), or the act the control omits (control run).
        const skipped = step?.kind === "act" && (index === control.cleanSkip || (run === "control" && index === control.omit));
        try {
          if (step?.kind === "arrange") {
            if (adapter?.arrange === undefined) completed = await defaultArrange(index, undefined);
            else {
              try {
                await adapter.arrange({ scenario, buyer: { ...buyer }, edit: null, page });
                completed = true;
              } catch (error) {
                add("arrange_failed", "only", run, index, { at: at(index), detail: `the adapter's arrange rejected: ${describeError(error)}` }, "arrange");
              }
            }
            if (!completed) stop(index);
          } else if (step?.kind === "rearrange") {
            // With a selection entry the default arrangement runs again; otherwise the details are re-typed on the current page.
            if (entryPath !== undefined) completed = await defaultArrange(index, step.edit);
            else if (adapter?.arrange !== undefined) completed = await fillDetails(index, step.edit);
            else {
              add("arrange_failed", "only", run, index, { at: at(index), detail: "no selection entry is declared and the adapter has no arrange function" }, "routes.selectionEntry");
            }
            if (!completed) stop(index);
          } else if (step?.kind === "withhold") {
            withhold = "armed";
          } else if (step?.kind === "act" && !skipped) {
            if (step.twice === true) {
              let release = () => undefined as void;
              hold = { used: false, released: new Promise<void>((resolve) => { release = resolve; }) };
              try {
                // The first create waits in the interceptor until the second click was attempted.
                if (await perform(step.action, index)) await page.perform(targetOf("action", step.action), { timeoutMs });
              } finally {
                release();
                hold = null;
              }
            } else await perform(step.action, index);
          } else if (step?.kind === "reload") {
            await page.reload();
          } else if (step?.kind === "expect") {
            progress = progressOf(step, policy);
            // Under the control the negated state is given only the quiet window to appear.
            const negated = underControl(index) && control.negates === progress.state;
            expected = await page.find(targetOf("state", progress.state), { timeoutMs: negated ? quietMs : timeoutMs });
            if (expected !== null && visible(expected) && run === "clean") {
              for (const offer of progress.offers) await actionShown(offer, index);
            }
          } else if (step?.kind === "outcome" && !(run === "control" && index >= control.skipOutcomesFrom)) {
            try {
              await outcomes!.produce(step.outcome, { subject });
              produced = step.outcome;
            } catch (error) {
              add("outcome_failed", "rejected", run, index, { at: at(index), name: step.outcome, detail: describeError(error) }, "outcomes");
              record.stopped = true;
            }
          }
          await page.settled({ quietMs, timeoutMs: timeoutMs + quietMs });
        } catch (error) {
          fault("page_failed", index, error);
        }
        if (step?.kind === "act" && !skipped) {
          if (withhold === "armed") add("stimulus_not_applied", "only", run, index, { at: at(index) });
          withhold = "idle";
        }
        let ledger: Ledger | null = null;
        let observedAnchors: string[] = [];
        let path: string | null = null;
        if (!record.stopped || completed) {
          ledger = await fromObserver(index, () => observer.ledger(subject));
          try {
            observedAnchors = await page.anchors(locators);
            path = page.path();
          } catch (error) {
            if (!record.stopped) fault("page_failed", index, error);
          }
        }
        const phase = step === undefined ? "settle" : underControl(index) ? "control"
          : step.kind === "arrange" || step.kind === "rearrange" ? "arrange" : step.kind === "expect" ? "observe" : "stimulus";
        const stepElapsed = elapsed(begin);
        byPhase[phase] = (byPhase[phase] ?? 0) + stepElapsed;
        record.steps.push({
          index, run, phase, action: step?.kind === "act" && !skipped ? step.action : null,
          expectedAnchor: progress === null ? null : `state:${progress.state}`,
          observedAnchors, path, elapsedMs: stepElapsed, commands, ledger,
        });
        // Declared auto-progress the page did not perform: the skipped action is still offered and the next state not reached.
        // Judged in the clean run only: the control blocks the status reads the page would learn its own progress from.
        const notPerformed = run === "clean" && control.cleanSkip !== null && index === control.cleanSkip + 1 && ledger !== null
          && observedAnchors.includes(`action:${(scenario.steps[control.cleanSkip] as ScenarioStep & { kind: "act" }).action}`)
          && nextProgress !== null && !observedAnchors.includes(`state:${nextProgress}`);
        if (notPerformed) {
          const action = (scenario.steps[control.cleanSkip!] as ScenarioStep & { kind: "act" }).action;
          add("auto_progress_not_performed", "only", run, index, { at: at(index), name: `action:${action}`, detail: `state:${nextProgress}` }, "autoProgress");
          record.stopped = true;
        } else if (produced !== null && ledger !== null) {
          // Each outcome has a ledger effect: an outcome the ledger does not show never counts as stimulus.
          const newAttempt = produced !== ON_EARLIER_ATTEMPT;
          const settling = SETTLING_OUTCOMES.has(produced);
          if (newAttempt ? ledger.attempts <= beforeOutcome.attempts : ledger.attempts < 1) {
            add("outcome_failed", "no_attempt", run, index, { at: at(index), name: produced, count: ledger.attempts, limit: beforeOutcome.attempts }, "outcomes");
            record.stopped = true;
          } else if (settling ? ledger.captures <= beforeOutcome.captures : ledger.captures !== beforeOutcome.captures) {
            add("outcome_failed", "no_effect", run, index, {
              at: at(index), name: produced, count: ledger.captures, limit: beforeOutcome.captures,
              detail: settling ? "more captures than" : "the same captures as",
            }, "outcomes");
            record.stopped = true;
          }
          beforeOutcome = { attempts: ledger.attempts, captures: ledger.captures };
        }
        if (produced === "declined") declines += 1;
        record.declines.set(index, declines);
        if (progress !== null && run === "clean" && !record.stopped) {
          const name = `state:${progress.state}`;
          const other = step?.kind === "expect" && step.byPolicy !== undefined
            ? POLICIES.filter((candidate) => candidate !== policy && Object.hasOwn(step.byPolicy!, candidate)).map((candidate) => `state:${step.byPolicy![candidate]!.state}`)
            : [];
          if (expected !== null && !visible(expected)) {
            add("anchor_hidden", "only", run, index, { at: at(index), name, detail: whyHidden(expected) }, fieldOf("state", progress.state));
          } else if (!observedAnchors.includes(name)) {
            const facts = { at: at(index), name, seen: observedAnchors.join(", "), detail: policy };
            const otherShown = other.find((anchor) => observedAnchors.includes(anchor));
            if (otherShown !== undefined) add("policy_mismatch", "only", run, index, { ...facts, seen: otherShown });
            else if (observedAnchors.some((anchor) => anchor.startsWith("state:"))) add("progress_not_reached", "only", run, index, facts);
            else add("adapter_anchor_missing", "state", run, index, facts, fieldOf("state", progress.state));
          }
        }
        if (stopState !== undefined && observedAnchors.includes(stopState)) {
          record.stoppedAt = index;
          break;
        }
        if (skipToSettle && index < scenario.steps.length) {
          skipToSettle = false;
          index = scenario.steps.length - 1;
        }
        if (exceededAt !== null) {
          add("request_budget_exceeded", "only", run, exceededAt, { at: at(exceededAt), count: record.creates, limit: scenario.budget.creates });
          record.stopped = true;
        }
      }
      if (!record.stopped && record.stoppedAt === null && observer.payableOrdersInDatabase !== undefined) {
        const counted = await fromObserver(scenario.steps.length, () => observer.payableOrdersInDatabase!());
        if (counted !== null) record.databaseAfter = counted;
      }
    } finally {
      if (remove !== null) await remove();
    }
    return record;
  };

  const clean = await runOnce("clean");
  if (stopState !== undefined) {
    if (clean.stoppedAt !== null) return { kind: "stopped", stoppedAt: options.stopAt!, steps: clean.steps };
    const last = clean.steps.at(-1);
    const first = [...judged].sort((a, b) => a.group - b.group || a.rank - b.rank || a.order - b.order)[0];
    throw refuse("storefront_stop_state_unreached",
      `${last === undefined ? `The clean run of ${scenario.id} recorded no step` : describe(last.index, "clean")} was the last step, and ${stopState} was not visible after any step${first === undefined ? "" : ` (first finding: ${first.finding.code})`}.`,
      "stop-at drives the clean run only until the state is visible, and the run ended without showing it.",
      "Fix what the first finding names, or stop at a state this store reaches; run the scenario without stopAt for a full verdict.");
  }
  const records: RunRecord[] = [clean];
  if (!clean.stopped && control.kind !== "none") records.push(await runOnce("control"));

  for (const record of records) {
    const { run, steps } = record;
    const where = (step: VerdictStep) => describe(step.index, run);
    const safety = scenario.safety;
    const limits: readonly [string, keyof Ledger, number | undefined][] = [
      ["duplicate_order", "payableOrders", safety.maxPayableOrders],
      ["duplicate_hold", "holds", safety.maxHolds],
      ["duplicate_capture", "captures", safety.maxCaptures],
      ["second_attempt", "attempts", safety.maxAttempts],
    ];
    for (const [code, field, limit] of limits) {
      if (limit === undefined) continue;
      const over = steps.find((step) => step.ledger !== null && step.ledger[field] > limit);
      if (over !== undefined) add(code, "only", run, over.index, { at: where(over), count: over.ledger![field], limit });
    }
    if (safety.noAttemptAfter !== undefined) {
      const base = steps.find((step) => step.index === safety.noAttemptAfter)?.ledger;
      const over = base == null ? undefined : steps.find((step) => step.index > safety.noAttemptAfter! && step.ledger !== null && step.ledger.attempts > base.attempts);
      if (over !== undefined) add("second_attempt", "only", run, over.index, { at: where(over), count: over.ledger!.attempts, limit: base!.attempts });
    }
    if (safety.attemptsPerDecline === true) {
      const allowed = (step: VerdictStep) => (record.declines.get(step.index) ?? 0) + 1;
      const over = steps.find((step) => step.ledger !== null && step.ledger.attempts > allowed(step));
      if (over !== undefined) add("second_attempt", "only", run, over.index, { at: where(over), count: over.ledger!.attempts, limit: allowed(over) });
    }
    const paid = steps.find((step) => step.ledger !== null && (step.ledger.captures < 1 || step.ledger.payableOrders !== 0)
      && step.observedAnchors.some((name) => PAID_STATES.has(name)));
    if (paid !== undefined) {
      add("forbidden_state_shown", "paid_without_capture", run, paid.index, {
        at: where(paid), name: paid.observedAnchors.filter((name) => PAID_STATES.has(name)).join(", "),
        detail: `${paid.ledger!.captures} captures and ${paid.ledger!.payableOrders} payable orders`,
      });
    }
    const forbidden = safety.forbiddenStates;
    if (forbidden !== undefined) {
      // Per run. The control run blocks the status reads, so any outcome it shows is one it cannot know; the clean run
      // may never show a ruled-out outcome, nor regress to a pre-outcome state once it showed the expected one.
      const anchorsOf = (states: readonly string[]) => new Set(states.map((state) => `state:${state}`));
      const firstShowing = (names: ReadonlySet<string>, from: number) => steps.find((step) => step.index >= from && step.observedAnchors.some((name) => names.has(name)));
      const report = (step: VerdictStep, names: ReadonlySet<string>, cause: string, detail?: string) => add("forbidden_state_shown", cause, run, step.index, {
        at: where(step), name: step.observedAnchors.filter((name) => names.has(name)).join(", "), ...(detail === undefined ? {} : { detail }),
      });
      if (run === "control") {
        const names = anchorsOf(forbidden.control);
        const shown = firstShowing(names, 0);
        if (shown !== undefined) report(shown, names, "unknowable");
      } else {
        const ruledOut = anchorsOf(forbidden.clean.ruledOut);
        const shown = firstShowing(ruledOut, 0);
        if (shown !== undefined) report(shown, ruledOut, "ruled_out");
        const after = forbidden.clean.afterShowing;
        const outcome = after === undefined ? undefined : steps.find((step) => step.observedAnchors.includes(`state:${after.state}`));
        if (after !== undefined && outcome !== undefined) {
          const regressions = anchorsOf(after.regressions);
          const back = firstShowing(regressions, outcome.index);
          if (back !== undefined) report(back, regressions, "regression", `state:${after.state}`);
        }
      }
    }
    if (run === "control") {
      // Judged over every recorded control step, also when the control run stopped.
      if (control.kind === "block_read" && record.blocked === 0) add("control_not_applied", "only", run, null, { at: "The control run" });
      const negated = control.negates === null ? null : `state:${control.negates}`;
      const reached = negated === null ? undefined : steps.find((step) => step.index >= control.start && step.observedAnchors.includes(negated));
      if (reached !== undefined) {
        const reads = steps.filter((step) => step.index >= control.start && step.index <= reached.index)
          .reduce((sum, step) => sum + step.commands.filter((command) => command.operation === "read").length, 0);
        if (control.kind === "omit_action" && reads > 0) {
          add("auto_progress_undeclared", "only", run, reached.index, { at: where(reached), name: negated!, detail: control.action!, count: reads });
        } else {
          add("vacuous_progress", control.kind === "omit_action" ? "omitted" : control.kind === "other_policy" ? "other_policy" : "blocked", run, reached.index, {
            at: where(reached), name: negated!, ...(control.action === undefined ? {} : { detail: control.action }),
          });
        }
      }
    }
    if (record.stopped) continue;
    const last = steps.at(-1)?.ledger ?? null;
    if (record.databaseBefore !== null && record.databaseAfter !== null && last !== null) {
      const added = record.databaseAfter - record.databaseBefore;
      if (added > last.payableOrders) add("order_outside_subject", "only", run, null, { at: `The ${run} run`, count: added, limit: last.payableOrders });
      else if (added < last.payableOrders) add("observer_failed", "unattributable", run, null, { at: `The ${run} run`, count: added, limit: last.payableOrders });
    }
    if (record.matched.create > 0 && last !== null && last.orders === 0) {
      add("observer_subject_unseen", "no_order_after_create", run, null, { at: `The ${run} run`, count: record.matched.create });
    }
    const firstOrder = steps.find((step) => step.ledger !== null && step.ledger.orders > 0);
    if (firstOrder !== undefined && !record.createSteps.has(firstOrder.index)) add("stimulus_not_create", "only", run, firstOrder.index, { at: where(firstOrder) });
    if (run === "clean") {
      if (record.matched.create === 0) add("adapter_matcher_unmatched", "create", run, null, { at: "The clean run" }, "commands.create");
      if (control.blocked.includes("read") && record.matched.read === 0) add("adapter_matcher_unmatched", "read", run, null, { at: "The clean run" }, "commands.read");
      if (control.blocked.length > 0 && record.blockedSetSeen === 0) {
        add("adapter_matcher_unmatched", "blocked_set", run, null, { at: "The clean run", name: `step ${control.start}`, detail: control.blocked.join(" or ") }, "commands");
      }
    }
  }
  const controlRun = records.find((record) => record.run === "control");
  const applied = controlRun === undefined ? false
    : control.kind === "block_read" ? controlRun.blocked > 0
      : control.kind === "omit_action" ? controlRun.steps.some((step) => step.index === control.omit)
        : control.kind === "other_policy";
  return finish({
    stimulus: { create: clean.matched.create, ...(read === undefined ? {} : { read: clean.matched.read }) },
    steps: records.flatMap((record) => record.steps),
    durations: { totalMs: 0, byPhase },
    applied,
  });
}

/** The state anchor a `stopAt` names: `checkout.<state>` for a state one of the scenario's expect steps names, under any policy. */
function stopStateOf(stopAt: string, expectSteps: readonly (ScenarioStep & { kind: "expect" })[]): string {
  const states = new Set(expectSteps.flatMap((step) => [step.state, ...Object.values(step.byPolicy ?? {}).map((progress) => progress.state)]));
  const state = typeof stopAt === "string" && stopAt.startsWith(STOP_PREFIX) ? stopAt.slice(STOP_PREFIX.length) : null;
  if (state === null || !states.has(state)) {
    throw refuse("storefront_stop_state_unknown", `stopAt is ${JSON.stringify(String(stopAt)).slice(0, 80)}.`,
      "stop-at drives the clean run to a state the scenario expects, named checkout.<state>.",
      `Pass one of ${[...states].sort().map((name) => `${STOP_PREFIX}${name}`).join(", ")}.`);
  }
  return `state:${state}`;
}
