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
 * run; the harness must not share it.
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
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_QUIET_MS = 3_000;
const DEFAULT_KEY_HEADER = "idempotency-key";
const CATALOGUE_VERSION = 1;
const RUN_ID = /^[A-Za-z0-9-]{8,40}$/;
const NAME = /^[a-z][a-z0-9_]*$/;
const ERROR_CODE = /^([a-z][a-z0-9_]*): ([^\n]*?\.)(?: |$)/;
/** Anything URL-like in a fault message: a scheme and everything up to the next space, credentials and query included. */
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S*/giu;
const STEP_KINDS: ReadonlySet<string> = new Set(["arrange", "rearrange", "withhold", "act", "reload", "expect"]);
const CONTROL_KINDS: ReadonlySet<string> = new Set(["none", "block_read"]);
/** Outcome kinds a run may need; none can be produced before the runner takes an outcome driver. */
const DECLARED_OUTCOMES: readonly string[] = [];
/** States that say the payment settled: the ledger must then show a capture and no payable order. */
const PAID_STATES: ReadonlySet<string> = new Set(["state:paid", "state:paid_pending_activation"]);
const DEFAULT_BUYER: Readonly<Record<string, string>> = {
  first_name: "Test", last_name: "Buyer", phone: "+15550100", address_line1: "1 Example Street", city: "Example City", postal_code: "00000",
};
const BUYER_FIELDS: ReadonlySet<string> = new Set(["first_name", "last_name", "phone", "address_line1", "address_line2", "city", "postal_code"]);

/** Where a code sits in the judgement order, and the result it gives when it is the first failing check. */
const JUDGEMENT: Readonly<Record<string, { readonly group: number; readonly rank: number; readonly result: StorefrontVerdict["result"] }>> = {
  tier_unreachable: { group: 0, rank: 0, result: "not_run" },
  page_failed: { group: 1, rank: 0, result: "not_run" },
  "observer_failed:rejected": { group: 1, rank: 0, result: "not_run" },
  arrange_failed: { group: 1, rank: 0, result: "not_run" },
  observer_subject_unseen: { group: 2, rank: 0, result: "not_run" },
  stimulus_not_create: { group: 3, rank: 0, result: "not_run" },
  stimulus_not_applied: { group: 3, rank: 0, result: "not_run" },
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
  "adapter_anchor_missing:state": { group: 7, rank: 0, result: "not_run" },
  control_not_applied: { group: 8, rank: 0, result: "not_run" },
  vacuous_progress: { group: 8, rank: 1, result: "vacuous" },
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

/** The first way a scenario object is malformed, or `null`. Nothing about it is trusted before this check. */
function scenarioProblem(scenario: StorefrontScenario): string | null {
  const value = scenario as unknown as Record<string, unknown>;
  if (typeof value.title !== "string" || !isName(value.purchaseMode)) return "title must be a string and purchaseMode a name";
  if (!isRecord(value.requires) || !Array.isArray(value.requires.outcomes) || !value.requires.outcomes.every(isName)) return "requires.outcomes must be a list of names";
  if (!isRecord(value.budget) || !isCount(value.budget.creates)) return "budget.creates must be an integer, 0 or more";
  if (!isRecord(value.text) || !["stimulus", "safety", "progress", "control"].every((key) => typeof (value.text as Record<string, unknown>)[key] === "string")) return "text must hold the four sentences";
  if (!Array.isArray(value.steps) || value.steps.length === 0) return "steps must be a non-empty list";
  for (const [index, step] of (value.steps as unknown[]).entries()) {
    if (!isRecord(step) || typeof step.kind !== "string" || !STEP_KINDS.has(step.kind)) return `step ${index} must have one of the kinds ${[...STEP_KINDS].join(", ")}`;
    if (step.kind === "act" && (!isName(step.action) || (step.twice !== undefined && typeof step.twice !== "boolean"))) return `step ${index} (act) needs an action name`;
    if (step.kind === "expect" && (!isName(step.state) || !Array.isArray(step.offers) || !step.offers.every(isName))) return `step ${index} (expect) needs a state name and a list of offered actions`;
    if (step.kind === "rearrange" && step.edit !== undefined && !isName(step.edit)) return `step ${index} (rearrange) edit must be a field name`;
  }
  if (!isRecord(value.safety) || !Object.entries(value.safety).every(([, limit]) => limit === undefined || isCount(limit))) return "safety limits must be integers, 0 or more";
  const control = value.control;
  if (!isRecord(control) || typeof control.kind !== "string" || !CONTROL_KINDS.has(control.kind)) return `control.kind must be one of ${[...CONTROL_KINDS].join(", ")}`;
  if (control.negates !== null && !isName(control.negates)) return "control.negates must be a state name or null";
  if (control.kind === "block_read") {
    if (!Array.isArray(control.commands) || control.commands.length === 0 || !control.commands.every((command) => command === "create" || command === "read")) return "control.commands must list create or read";
    if (!isCount(control.from) || control.from >= value.steps.length) return "control.from must be the index of one of its steps";
    if (control.negates === null) return "a block_read control must negate a state";
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

function describeStep(step: ScenarioStep): string {
  if (step.kind === "act") return `act ${step.action}${step.twice === true ? " twice" : ""}`;
  if (step.kind === "expect") return `expect ${step.state}`;
  if (step.kind === "rearrange" && step.edit !== undefined) return `rearrange editing ${step.edit}`;
  return step.kind;
}

/** The adapter's `actions`, keyed by full anchor name: a state name becomes `state:<name>`, any other `action:<name>`. */
function anchorLocators(actions: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const locators: Record<string, string> = {};
  for (const [name, locator] of Object.entries(actions ?? {})) {
    locators[Object.hasOwn(storefrontAnchor.state, name) ? `state:${name}` : `action:${name}`] = locator;
  }
  return locators;
}

type Judged = { readonly group: number; readonly rank: number; readonly result: StorefrontVerdict["result"]; readonly order: number; readonly finding: VerdictFinding };

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
};

/**
 * Runs one storefront scenario and resolves `{ kind: "verdict", verdict }`, a
 * format-1 verdict that `parseStorefrontVerdict` accepts.
 *
 * The clean run reads the subject's ledger (an earlier order ends `not_run`),
 * installs one interceptor that classifies requests by the create and read
 * matchers, records each command's key reuse (key values are compared in
 * memory, never stored) and applies the armed withhold or hold, then runs the
 * steps. Every step ends only when the page has settled: every request the
 * interceptor saw finished and `quietMs` passed with no new request. Then the
 * runner reads the ledger, the visible anchors and the path. After the last
 * step a settle window waits once more and reads them again. The control run
 * repeats the steps under the other subject, blocking from the control's step
 * every request of its commands; a `safety_only` scenario has none.
 *
 * Judgement, first failing group decides: 1 page, observer and arrangement
 * worked; 2 no order before the arrangement and one after the first matched
 * create; 3 the first order appeared in a step with a matched create and every
 * withhold applied; 4 ledger safety in both runs and settle windows (payable
 * orders, orders holding stock, attempts, captures; a paid state needs a
 * capture and no payable order) and, for an exclusive database, no payable
 * order outside the subjects; 5 the create budget kept (a run over it stopped
 * before proving anything, but a violation it already caused stands); 6 each
 * matcher used matched and each needed anchor resolved and was visible; 7 the
 * clean run reached its expected state; 8 the control blocked a request and its
 * negated state was not reached, judged over every recorded control step even
 * when the control run stopped. Codes 1–3, 5 and 6 end `not_run`, a harness
 * fault is never `failed` or `passed`; a ledger violation is `failed`; progress under the control is
 * `vacuous`. Without a finding the result is `passed`, or `safety_only` for a
 * scenario without a control.
 *
 * A scenario whose `requires.outcomes` names an outcome the run's outcome
 * driver does not declare ends `not_run` with `tier_unreachable` before any page
 * or observer call; this runner takes no outcome driver yet, so
 * `harness.declaredOutcomes` is empty. Invalid options (an unknown scenario, a
 * malformed `runId`, a missing or mismatched `width`, a clock outside integer
 * milliseconds 0 to the end of the year 9999) reject with a `TypeError` starting
 * `storefront_scenario_unknown` or `storefront_run_input_invalid`, and nothing
 * is driven, as does a malformed scenario object. An arrangement that fails
 * under the control is the control's effect: the remaining steps are skipped
 * and the settle window still samples the page. Anchors and the ledger are
 * sampled after each step settles and in the settle window, so a state shown
 * only inside a step is not seen. A fault's text keeps its code and first
 * sentence with every URL replaced. The clean and control runs share the page
 * and its browser storage.
 *
 * @experimental
 */
export async function runStorefrontScenario(options: StorefrontRunOptions): Promise<{ kind: "verdict"; verdict: StorefrontVerdict }> {
  const scenario = resolveScenario(options.scenario);
  const { page, observer, adapter, proofFile, clock } = options;
  if (typeof options.runId !== "string" || !RUN_ID.test(options.runId)) {
    throw invalid(`runId is ${JSON.stringify(String(options.runId)).slice(0, 60)}.`, "Pass a runId of 8 to 40 letters, digits and hyphens, new for every run.");
  }
  const channel = options.channel ?? "browser_ui";
  const timeoutMs = nonNegative(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  const quietMs = nonNegative(options.quietMs, DEFAULT_QUIET_MS, "quietMs");
  if (channel === "browser_ui" && (typeof options.width !== "number" || !Number.isSafeInteger(options.width) || options.width <= 0)) {
    throw invalid(`width is ${String(options.width)} for the browser_ui channel.`, "Pass the page's viewport width in CSS pixels as a positive integer.");
  }
  const create = adapter?.commands?.create ?? options.commands?.create;
  const read = adapter?.commands?.read ?? options.commands?.read;
  const keyHeader = adapter?.commands?.keyHeader ?? options.commands?.keyHeader ?? DEFAULT_KEY_HEADER;
  const control = scenario.control;
  const blockedSet: readonly Operation[] = control.kind === "block_read" ? control.commands ?? [] : [];
  const controlFrom = control.kind === "block_read" ? control.from ?? 0 : Number.POSITIVE_INFINITY;
  if (create === undefined) throw invalid("No create matcher is given.", "Pass commands.create, or give the adapter commands.create.");
  if (blockedSet.includes("read") && read === undefined) throw invalid(`Scenario ${scenario.id} blocks reads but no read matcher is given.`, "Pass commands.read, or give the adapter commands.read.");
  const started = clock.now();
  utcInstant(started);
  const recheck = (adapter?.recheck ?? proofFile?.recheck)?.replaceAll("{scenario}", scenario.id)
    ?? `Run scenario ${scenario.id} again with the same harness.`;
  const adapterFields = adapter === undefined ? [] : Object.keys(adapter).filter((key) => (adapter as Record<string, unknown>)[key] !== undefined).sort();
  const autoProgress = [...(adapter?.autoProgress ?? proofFile?.autoProgress ?? [])];
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
      declaredOutcomes: [...DECLARED_OUTCOMES].sort(),
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
      finding: { code, run, step, ...(field === undefined ? {} : { field }), observed: text.observed, cause: text.cause, fix: text.fix, recheck },
    });
  };
  const finish = (rest: Omit<Parameters<typeof verdictOf>[0], "result" | "findings" | "completedAt">) => {
    const ended = clock.now();
    const completedAt = utcInstant(ended);
    const ordered = [...judged].sort((a, b) => a.group - b.group || a.rank - b.rank || a.order - b.order);
    const result = ordered[0]?.result ?? (control.kind === "none" ? "safety_only" : "passed");
    const verdict = verdictOf({ ...rest, result, findings: ordered.map((entry) => entry.finding), completedAt,
      durations: { ...rest.durations, totalMs: Math.max(0, Math.round(ended - started)) } });
    const parsed = parseStorefrontVerdict(JSON.stringify(verdict));
    if (!parsed.ok) throw new Error(`storefront runner produced a verdict its parser refuses: ${parsed.refusal.observed}`);
    return { kind: "verdict" as const, verdict };
  };

  // Admission: a required outcome the run's driver does not declare ends the scenario before any page or observer call.
  const missing = scenario.requires.outcomes.filter((outcome) => !DECLARED_OUTCOMES.includes(outcome));
  if (missing.length > 0) {
    add("tier_unreachable", "only", null, null, { at: `Scenario ${scenario.id}`, detail: missing.join(", ") });
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

  const runOnce = async (run: RunName): Promise<RunRecord> => {
    const subject = `storefront-${options.runId}-${run}@example.test`;
    const buyer: Record<string, string | boolean> = { email: subject };
    for (const [field, value] of Object.entries({ ...DEFAULT_BUYER, ...proofFile?.buyer })) {
      if (BUYER_FIELDS.has(field) && typeof value === "string") buyer[field] = value;
    }
    buyer.terms_accepted = true;
    const record: RunRecord = {
      run, steps: [], stopped: false, matched: { create: 0, read: 0 }, creates: 0, blocked: 0, blockedSetSeen: 0,
      createSteps: new Set(), databaseBefore: null, databaseAfter: null,
    };
    let stepIndex = -1;
    let commands: VerdictStep["commands"] = [];
    let ordinal = 0;
    const keys = new Map<string, number>();
    let withhold: "idle" | "armed" | "applied" = "idle";
    let hold: { used: boolean; released: Promise<void> } | null = null;
    let exceededAt: number | null = null;
    const at = (index: number) => index === scenario.steps.length
      ? `The settle window of the ${run} run`
      : `Step ${index} (${describeStep(scenario.steps[index]!)}) of the ${run} run`;
    const checksAnchors = (index: number) => run === "clean" || index < controlFrom;
    // Under the control a failed arrangement is the control's effect, not a fault: the rest of the steps is skipped
    // and the settle window still samples the page. Before the control starts it stops the run.
    let skipToSettle = false;
    const stop = (index: number) => {
      if (run === "control" && index >= controlFrom) skipToSettle = true;
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
      const blocking = stepIndex >= controlFrom && blockedSet.includes(operation);
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
          } else if (step?.kind === "act") {
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
            // Under the control the negated state is given only the quiet window to appear.
            const negated = run === "control" && index >= controlFrom && control.negates === step.state;
            expected = await page.find(targetOf("state", step.state), { timeoutMs: negated ? quietMs : timeoutMs });
            if (expected !== null && visible(expected) && run === "clean") {
              for (const offer of step.offers) await actionShown(offer, index);
            }
          }
          await page.settled({ quietMs, timeoutMs: timeoutMs + quietMs });
        } catch (error) {
          fault("page_failed", index, error);
        }
        if (step?.kind === "act") {
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
        const phase = step === undefined ? "settle" : index >= controlFrom && run === "control" ? "control"
          : step.kind === "arrange" || step.kind === "rearrange" ? "arrange" : step.kind === "expect" ? "observe" : "stimulus";
        const stepElapsed = elapsed(begin);
        byPhase[phase] = (byPhase[phase] ?? 0) + stepElapsed;
        record.steps.push({
          index, run, phase, action: step?.kind === "act" ? step.action : null,
          expectedAnchor: step?.kind === "expect" ? `state:${step.state}` : null,
          observedAnchors, path, elapsedMs: stepElapsed, commands, ledger,
        });
        if (step?.kind === "expect" && run === "clean" && !record.stopped) {
          const name = `state:${step.state}`;
          if (expected !== null && !visible(expected)) {
            add("anchor_hidden", "only", run, index, { at: at(index), name, detail: whyHidden(expected) }, fieldOf("state", step.state));
          } else if (!observedAnchors.includes(name)) {
            const facts = { at: at(index), name, seen: observedAnchors.join(", ") };
            if (observedAnchors.some((anchor) => anchor.startsWith("state:"))) add("progress_not_reached", "only", run, index, facts);
            else add("adapter_anchor_missing", "state", run, index, facts, fieldOf("state", step.state));
          }
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
      if (!record.stopped && observer.payableOrdersInDatabase !== undefined) {
        const counted = await fromObserver(scenario.steps.length, () => observer.payableOrdersInDatabase!());
        if (counted !== null) record.databaseAfter = counted;
      }
    } finally {
      if (remove !== null) await remove();
    }
    return record;
  };

  const records: RunRecord[] = [];
  const clean = await runOnce("clean");
  records.push(clean);
  if (!clean.stopped && control.kind !== "none") records.push(await runOnce("control"));

  for (const record of records) {
    const { run, steps } = record;
    const where = (step: VerdictStep) => step.index === scenario.steps.length ? `The settle window of the ${run} run` : `Step ${step.index} (${describeStep(scenario.steps[step.index]!)}) of the ${run} run`;
    const limits: readonly [string, keyof Ledger, number | undefined][] = [
      ["duplicate_order", "payableOrders", scenario.safety.maxPayableOrders],
      ["duplicate_hold", "holds", scenario.safety.maxHolds],
      ["duplicate_capture", "captures", scenario.safety.maxCaptures],
      ["second_attempt", "attempts", scenario.safety.maxAttempts],
    ];
    for (const [code, field, limit] of limits) {
      if (limit === undefined) continue;
      const over = steps.find((step) => step.ledger !== null && step.ledger[field] > limit);
      if (over !== undefined) add(code, "only", run, over.index, { at: where(over), count: over.ledger![field], limit });
    }
    const paid = steps.find((step) => step.ledger !== null && (step.ledger.captures < 1 || step.ledger.payableOrders !== 0)
      && step.observedAnchors.some((name) => PAID_STATES.has(name)));
    if (paid !== undefined) {
      add("forbidden_state_shown", "only", run, paid.index, {
        at: where(paid), name: paid.observedAnchors.filter((name) => PAID_STATES.has(name)).join(", "),
        detail: `${paid.ledger!.captures} captures and ${paid.ledger!.payableOrders} payable orders`,
      });
    }
    if (run === "control") {
      // Judged over every recorded control step, also when the control run stopped.
      if (record.blocked === 0) add("control_not_applied", "only", run, null, { at: "The control run" });
      const reached = steps.find((step) => step.index >= controlFrom && control.negates !== null && step.observedAnchors.includes(`state:${control.negates}`));
      if (reached !== undefined) add("vacuous_progress", "only", run, reached.index, { at: where(reached), name: `state:${control.negates}` });
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
      if (blockedSet.includes("read") && record.matched.read === 0) add("adapter_matcher_unmatched", "read", run, null, { at: "The clean run" }, "commands.read");
      if (blockedSet.length > 0 && record.blockedSetSeen === 0) {
        add("adapter_matcher_unmatched", "blocked_set", run, null, { at: "The clean run", name: `step ${controlFrom}`, detail: blockedSet.join(" or ") }, "commands");
      }
    }
  }
  const controlRun = records.find((record) => record.run === "control");
  return finish({
    stimulus: { create: clean.matched.create, ...(read === undefined ? {} : { read: clean.matched.read }) },
    steps: records.flatMap((record) => record.steps),
    durations: { totalMs: 0, byPhase },
    applied: controlRun !== undefined && controlRun.blocked > 0,
  });
}
