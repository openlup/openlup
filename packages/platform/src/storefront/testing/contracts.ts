import type { StorefrontVerdict } from "../../lifecycle/index.js";

/** The run subject's ledger, with the meanings of the verdict's step ledger. */
type StorefrontLedger = NonNullable<StorefrontVerdict["steps"][number]["ledger"]>;

/** A buyer action or state the scenario expects, with the actions that state must offer. */
type StorefrontExpectedProgress = { readonly state: string; readonly offers: readonly string[] };

/**
 * A request as a command matcher sees it: the method and the request path,
 * without query string or fragment.
 */
type StorefrontMatchedRequest = { readonly method: string; readonly path: string };

/** `{ method, path }` matches that method and exactly that path; a predicate decides for itself. */
type StorefrontCommandMatcher = StorefrontMatchedRequest | ((request: StorefrontMatchedRequest) => boolean);

/** An anchor by its attribute group and value, or a custom CSS locator. */
type StorefrontPageTarget =
  | { readonly attribute: "action" | "state" | "field" | "value"; readonly value: string }
  | { readonly locator: string };

/** What `intercept` does with one request: let it through, deliver it and fail the page's response, or never send it. */
type StorefrontRequestDecision = "pass" | "withhold" | "block";

/**
 * One storefront proof scenario: a buyer journey with a stimulus, the ledger
 * safety it must keep, the progress it must reach and the control that must
 * keep that progress from being reached.
 *
 * Step kinds, safety rules and control kinds are run by the storefront runner.
 * This step, safety and control language is public at `testing` maturity, so
 * its shape may change in a minor release with an upgrade note.
 *
 * - `requires.outcomes` lists the outcomes a run's outcome driver must declare
 *   for the scenario to be admitted; empty means none. It names no tier: the
 *   highest tier at which a store can prove the scenario is the highest tier
 *   whose driver declares these outcomes.
 * - `budget.creates` is the number of create requests one run may send.
 * - `text` holds one sentence each on the stimulus, the safety rule, the
 *   progress and the control.
 * - Step, `noAttemptAfter`, `forbiddenStates.after` and `control.from` indices
 *   count from 0 within `steps`.
 *
 * @experimental
 */
export type StorefrontScenario = {
  readonly id: string;
  readonly title: string;
  readonly purchaseMode: "one_time" | "subscription" | (string & {});
  readonly requires: { readonly outcomes: readonly string[] };
  readonly budget: { readonly creates: number };
  readonly text: { readonly stimulus: string; readonly safety: string; readonly progress: string; readonly control: string };
  readonly steps: readonly (
    /** Store-owned steps up to the first buyer action. */
    | { readonly kind: "arrange" }
    /** After a reload: arrange again, or re-type the details only; `edit` names a field to change. */
    | { readonly kind: "rearrange"; readonly edit?: string }
    /** Withhold the response to the first create the next `act` sends. */
    | { readonly kind: "withhold" }
    /** Perform a buyer action; `twice` performs it twice and holds the first create until the second was attempted. */
    | { readonly kind: "act"; readonly action: string; readonly twice?: boolean }
    | { readonly kind: "reload" }
    /** Wait for a state and the actions it must offer; `byPolicy` replaces both per changed-payload policy. */
    | (StorefrontExpectedProgress & { readonly kind: "expect"; readonly byPolicy?: Readonly<Record<string, StorefrontExpectedProgress>> })
    /** Ask the outcome driver for one outcome. */
    | { readonly kind: "outcome"; readonly outcome: string }
  )[];
  readonly safety: {
    readonly maxPayableOrders?: number;
    readonly maxHolds?: number;
    readonly maxAttempts?: number;
    readonly maxCaptures?: number;
    /** No payment attempt after the step at this index. */
    readonly noAttemptAfter?: number;
    /** Attempts never exceed declines plus one. */
    readonly attemptsPerDecline?: boolean;
    /** States that must not be shown after the step at index `after`. */
    readonly forbiddenStates?: { readonly after: number; readonly states: readonly string[] };
  };
  readonly control: {
    readonly kind: "none" | "block_read" | "omit_action" | "other_policy" | (string & {});
    /** The state the control must keep from being reached; `null` for `none` and for `other_policy`, whose state follows the declared policy. */
    readonly negates: string | null;
    /** `block_read`: the commands blocked, from the step at index `from`. */
    readonly commands?: readonly ("create" | "read")[];
    readonly from?: number;
    /** `omit_action`: the omitted action. */
    readonly action?: string;
    /** Whether outcome steps after the control's start run (`kept`) or not (`skipped`). */
    readonly outcomes?: "kept" | "skipped";
  };
};

/**
 * A store's departures from the default proof harness. Every field is
 * optional; a field here overrides the proof file, which overrides the run's
 * defaults.
 *
 * A command matcher sees only the method and the request path, without query
 * string or fragment, so a token carried in a query never reaches a matcher or
 * a verdict. Stated limits: a store whose operations share one endpoint (for
 * example a single GraphQL path) cannot tell create from read by matcher;
 * status delivered over server-sent events or a WebSocket is not a request the
 * page handle can block; requests answered by a service worker are not routed
 * unless the harness blocks service workers in its browser context; a
 * cross-origin request is matched by path alone; a redirect is followed to the
 * request the browser reports it redirected to, and a hop the browser does not
 * report is covered only by the quiet window.
 *
 * @experimental
 */
export type StorefrontAdapter = {
  /** Store-owned steps up to the first buyer action. `edit` names a field to change on a rearrangement, else `null`. */
  readonly arrange?: (context: {
    readonly scenario: StorefrontScenario;
    readonly buyer: Readonly<Record<string, string | boolean>>;
    readonly edit: string | null;
    readonly page: PageHandle;
  }) => Promise<void>;
  /** Action or state name to a CSS selector that replaces its attribute anchor. */
  readonly actions?: Readonly<Record<string, string>>;
  /** `keyHeader` names the request header that carries the command key; its value is compared, never recorded. */
  readonly commands?: { readonly create?: StorefrontCommandMatcher; readonly read?: StorefrontCommandMatcher; readonly keyHeader?: string };
  /** Action names the UI performs by itself. */
  readonly autoProgress?: readonly string[];
  /** As the proof file's `routes`. */
  readonly routes?: { readonly surfaces?: Readonly<Record<string, string>>; readonly selectionEntry?: Readonly<Record<string, string>> };
  /** Command that reruns one scenario; `{scenario}` is replaced by the scenario id. */
  readonly recheck?: string;
};

/**
 * Reads the ledger of one run subject (its e-mail): `orders` in any status,
 * `payableOrders` awaiting payment, `holds` orders holding at least one stock
 * reservation, `attempts` payment attempts, `captures` captured payments (one
 * per capture). `payableOrdersInDatabase` exists only when the observer reads a
 * database exclusive to one run; the harness must not share that database.
 *
 * @experimental
 */
export type StorefrontObserver = {
  readonly kind: "fixture" | "package" | "store" | (string & {});
  ledger(subject: string): Promise<StorefrontLedger>;
  payableOrdersInDatabase?(): Promise<number>;
};

/**
 * The page operations a storefront proof needs, over one browser page.
 * `createPageHandle` builds one from a Playwright page.
 *
 * - `path()` is the current path without query string or fragment;
 *   `width()` the viewport width in CSS pixels, or `null`.
 * - `find` scrolls the first match into view when it is not already shown in
 *   full and measures it, or resolves
 *   `null` when none appeared within `timeoutMs`; every scroll position is
 *   restored afterwards, instantly whatever the page's `scroll-behavior`. An
 *   anchor is visible when its box is non-zero; the buyer can bring it into
 *   view (judged before anything moves, from the anchor outward: a scroller the
 *   buyer can scroll brings its content into its range, while a locked one,
 *   `overflow: hidden` or `clip` on a container or on the viewport as in an app
 *   shell or a body scroll lock, must already show the anchor or an
 *   anchor-sized part of what an inner scrollable scroller shows); is not
 *   hidden (`display: none`, a `hidden` attribute up the tree, or an inherited
 *   `visibility` other than `visible`); is not fully transparent (the product of
 *   its and its ancestors' computed opacity is 0); and some part of it survives
 *   the overflow boxes of the ancestors in its containing-block chain (a fixed
 *   or absolute box escapes those outside it; the root scroller never clips)
 *   and its own and its ancestors' `clip` and `clip-path`, with the element hit at that part's centre being the anchor, a
 *   descendant or an ancestor of it (an ancestor only when no `clip-path` other
 *   than `inset()` lies on the way).
 * - `anchors(locators)` lists the visible `state:<value>` and
 *   `action:<value>` anchors, sorted; `locators` maps such a name to a custom
 *   CSS locator that replaces its attribute anchor.
 * - `perform` clicks, and resolves `false` without clicking when the target is
 *   absent or disabled; `fill` types a string or sets a checkbox, `false` when
 *   absent.
 * - `intercept(decide)` routes every request through `decide`, with the request
 *   path and no query string or fragment; a `decide` that throws blocks the
 *   request. It resolves a removal function.
 * - `settled({ quietMs })` resolves once every request `decide` saw has
 *   finished (its response delivered, or aborted), following a redirect to the
 *   request it was redirected to, and `quietMs` passed with no new request.
 *
 * @experimental
 */
export type PageHandle = {
  navigate(path: string): Promise<void>;
  reload(): Promise<void>;
  path(): string;
  width(): number | null;
  find(target: StorefrontPageTarget, options: { readonly timeoutMs: number }): Promise<{
    width: number;
    height: number;
    insideScrollArea: boolean;
    hidden: boolean;
    transparent: boolean;
    coveredAtCentre: boolean;
  } | null>;
  anchors(locators?: Readonly<Record<string, string>>): Promise<string[]>;
  perform(target: StorefrontPageTarget, options: { readonly timeoutMs: number }): Promise<boolean>;
  fill(target: StorefrontPageTarget, value: string | boolean, options: { readonly timeoutMs: number }): Promise<boolean>;
  intercept(decide: (request: StorefrontMatchedRequest & { header(name: string): string | null }) => StorefrontRequestDecision | Promise<StorefrontRequestDecision>): Promise<() => Promise<void>>;
  settled(options: { readonly quietMs: number }): Promise<void>;
};
