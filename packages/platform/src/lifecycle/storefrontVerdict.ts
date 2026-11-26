import { browserVerdictSchema, frozenJsonSchema, OPEN_SET_PATTERN, parseVersionedContract, verdictSchema } from "./storefrontVerdictSchema.js";
import { z } from "zod";

/**
 * Codes a storefront verdict's findings carry. The set is open: a reader keeps a
 * default branch for a code it does not know. Each code names the part at fault:
 *
 * - The UI: `duplicate_order` (more payable orders than the scenario allows),
 *   `duplicate_hold` (more orders holding stock), `duplicate_capture` (a payment
 *   captured more than once), `second_attempt` (a payment attempt the scenario
 *   forbids), `forbidden_state_shown` (a state the ledger contradicts, such as
 *   `paid` without a capture), `order_outside_subject` (orders added outside the
 *   run's buyer), `progress_not_reached` (another state shown where the expected
 *   one was due), `policy_mismatch` (changed details handled against the
 *   declared policy), `vacuous_progress` (the control reached the state it must
 *   not reach, so the clean pass proves nothing), `auto_progress_undeclared`
 *   (the UI acted by itself without declaring it).
 * - The adapter or proof file: `adapter_matcher_unmatched` (a command matcher
 *   matched no request), `adapter_anchor_missing` (an anchor did not resolve),
 *   `anchor_hidden` (an anchor resolved but was not visible),
 *   `auto_progress_not_performed` (an action declared in `autoProgress` that the
 *   UI leaves to the buyer).
 * - The harness: `control_not_applied`, `arrange_failed`, `stimulus_not_create`,
 *   `stimulus_not_applied`, `tier_unreachable`, `page_failed`,
 *   `request_budget_exceeded`.
 * - The outcome driver: `outcome_failed`.
 * - The observer: `observer_subject_unseen`, `observer_failed`.
 *
 * @experimental
 */
export type StorefrontFindingCode =
  | "duplicate_order"
  | "duplicate_hold"
  | "duplicate_capture"
  | "second_attempt"
  | "forbidden_state_shown"
  | "order_outside_subject"
  | "progress_not_reached"
  | "policy_mismatch"
  | "vacuous_progress"
  | "auto_progress_undeclared"
  | "auto_progress_not_performed"
  | "adapter_matcher_unmatched"
  | "adapter_anchor_missing"
  | "anchor_hidden"
  | "control_not_applied"
  | "arrange_failed"
  | "observer_subject_unseen"
  | "stimulus_not_create"
  | "stimulus_not_applied"
  | "tier_unreachable"
  | "outcome_failed"
  | "observer_failed"
  | "page_failed"
  | "request_budget_exceeded"
  | (string & {});

/**
 * A storefront verdict, format version 1: what one scenario run observed and
 * concluded. Scenario ids, tiers, channels, results, runs, phases, control kinds,
 * observer kinds, build sources, adapter kinds and finding codes are open sets
 * matching `^[a-z][a-z0-9_]*$`; a reader keeps a default branch for each.
 *
 * No field holds a request body, a response body, a token or a command key value.
 * Unknown fields at any level are kept by `parseStorefrontVerdict`, except an
 * own `__proto__` key, which is dropped so a reader's objects keep their
 * prototype; the runner neither reads nor writes unknown fields.
 *
 * Within format version 1 fields are only added. Until the first release that
 * carries the storefront runner, format version 1 may still be amended without a
 * version bump; afterwards a removed field or changed meaning raises
 * `formatVersion`.
 *
 * @experimental
 */
export type StorefrontVerdict = {
  formatVersion: 1;
  /** Unique per run, supplied by whoever ran the scenario. */
  runId: string;
  /**
   * A real UTC instant with milliseconds (`YYYY-MM-DDTHH:mm:ss.sssZ`; month lengths
   * and leap years are checked). "Newest" means the latest `completedAt`, never a file time.
   */
  completedAt: string;
  scenario: string;
  tier: "fixture_preview" | "postgres_sandbox" | (string & {});
  /** The store configuration id the run used. */
  profile: string;
  channel: "browser_ui" | (string & {});
  /** CSS pixels; required when `channel` is `browser_ui`. */
  width?: number;
  /** `not_run` is missing evidence, never a pass. */
  result: "passed" | "failed" | "vacuous" | "safety_only" | "not_run" | (string & {});
  control: {
    kind: "omit_action" | "block_read" | "other_policy" | "none" | (string & {});
    /** The omitted action. */
    action?: string;
    /** The anchor state the control must keep from being reached; `null` for `none`. */
    negates: string | null;
    /** Whether the control took effect. */
    applied: boolean;
  };
  /** Per command matcher (`create`, `read`), requests matched in the clean run. */
  stimulus: Record<string, number>;
  /** `index` and every command `ordinal` count from 0 within each run. */
  steps: {
    index: number;
    run: "clean" | "control" | (string & {});
    phase: "arrange" | "stimulus" | "control" | "observe" | "settle" | (string & {});
    action: string | null;
    /** `state:<value>`. */
    expectedAnchor: string | null;
    /** `state:<value>` and `action:<value>`. */
    observedAnchors: string[];
    /** Starts with `/`, without query or fragment. */
    path: string | null;
    elapsedMs: number;
    commands: {
      operation: string;
      ordinal: number;
      /** `sameAs` is the ordinal of the first earlier command with the same key; the key value is never recorded. */
      key: { present: boolean; sameAs: number | null };
    }[];
    /**
     * The run subject's ledger after the step: `orders` in any status,
     * `payableOrders` awaiting payment, `holds` orders holding at least one stock
     * reservation, `attempts` payment attempts, `captures` captured payments (one per capture).
     */
    ledger: { orders: number; payableOrders: number; holds: number; attempts: number; captures: number } | null;
  }[];
  findings: {
    code: StorefrontFindingCode;
    /** `null` for a check of the whole scenario. */
    run: "clean" | "control" | (string & {}) | null;
    /** Step index within that run. */
    step: number | null;
    /** The adapter or proof-file field at fault. */
    field?: string;
    observed: string;
    cause: string;
    fix: string;
    recheck: string;
  }[];
  /**
   * The identity of the build the run exercised. Two identities are equal when
   * the package set (`name`, `version`, `integrity`), the client digests (`name`,
   * `digest`) and `proofFile` are equal; a package with `integrity` never equals
   * one without, and `source` is not part of equality. A verdict is reusable only
   * for an equal identity; one read from a workspace is a claim whatever its `source`.
   */
  build: {
    source: "claimed" | "ci" | (string & {});
    /**
     * `integrity` is absent or a space-separated list of SRI hash expressions, as
     * npm writes it, holding at least one SHA-256, SHA-384 or SHA-512 hash; it is
     * compared as written.
     */
    packages: { name: string; version: string; integrity?: string }[];
    /** One per client build served; `digest` from `digestStorefrontFiles`. */
    clients: { name: string; digest: string }[];
    /** Digest of the proof file, or `null`. */
    proofFile: string | null;
  };
  harness: {
    /** The caller's claim about the installed runner, copied, not evidence. */
    runnerVersion: string;
    catalogueVersion: number;
    adapter: { kind: "default" | "custom" | (string & {}); fields: string[]; digest: string | null };
    /** Action names the UI performs by itself. */
    autoProgress: string[];
    observer: "fixture" | "package" | "store" | (string & {});
    /**
     * The outcome driver's declaration as given, sorted; empty when the run had no
     * driver. A scenario that needs an outcome outside it is `not_run`, never
     * `passed`; readiness and promotion treat `not_run` as missing evidence.
     */
    declaredOutcomes: string[];
  };
  durations: { totalMs: number; byPhase: Record<string, number> };
};

/**
 * Parses verdict text. Order: JSON object, `formatVersion`, `channel`, then the
 * one schema the channel selects (`browser_ui` requires `width`), so a refusal
 * names the real failing path. Never throws; unknown fields are kept.
 *
 * @experimental
 */
export function parseStorefrontVerdict(text: string):
  | { ok: true; verdict: StorefrontVerdict }
  | { ok: false; refusal: { code: "storefront_verdict_invalid" | "storefront_verdict_version_unsupported"; observed: string; cause: string; fix: string; recheck: string } } {
  const parsed = parseVersionedContract<StorefrontVerdict, "storefront_verdict_invalid", "storefront_verdict_version_unsupported">(
    text,
    { subject: "storefront verdict", invalid: "storefront_verdict_invalid", unsupported: "storefront_verdict_version_unsupported", parser: "parseStorefrontVerdict" },
    (input) => {
      const channel = input.channel;
      if (typeof channel !== "string" || !OPEN_SET_PATTERN.test(channel)) return { path: "channel", message: "expected a string matching ^[a-z][a-z0-9_]*$" };
      return channel === "browser_ui" ? browserVerdictSchema : verdictSchema;
    },
  );
  return parsed.ok ? { ok: true, verdict: parsed.value } : parsed;
}

/**
 * The verdict's JSON Schema (draft-07), as data: `anyOf` a `browser_ui` branch
 * that requires `width` and a branch for every other channel. Unknown properties
 * are allowed. Frozen.
 *
 * @experimental
 */
export const storefrontVerdictJsonSchema: Readonly<Record<string, unknown>> = frozenJsonSchema(z.union([browserVerdictSchema, verdictSchema]));
