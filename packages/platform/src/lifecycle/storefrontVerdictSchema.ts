import { z } from "zod";

// Internal: imported only by implementation, so no public declaration (and no
// zod type) reaches the API report. `StorefrontVerdict` is checked against
// `verdictSchema` by test/lifecycle/storefrontVerdictTypes.test.ts.

/** Grammar of every open-set value. */
export const OPEN_SET_PATTERN = /^[a-z][a-z0-9_]*$/;

// Known members of each open set; the type test checks each list exhaustively.
export const knownTiers = ["fixture_preview", "postgres_sandbox"] as const;
export const knownChannels = ["browser_ui"] as const;
export const knownResults = ["passed", "failed", "vacuous", "safety_only", "not_run"] as const;
export const knownRuns = ["clean", "control"] as const;
export const knownPhases = ["arrange", "stimulus", "control", "observe", "settle"] as const;
export const knownControlKinds = ["omit_action", "block_read", "other_policy", "none"] as const;
export const knownBuildSources = ["claimed", "ci"] as const;
export const knownAdapterKinds = ["default", "custom"] as const;
export const knownObserverKinds = ["fixture", "package", "store"] as const;
export const knownChangedPayloadPolicies = ["update_in_place", "refuse_changed"] as const;
export const knownFindingCodes = [
  "duplicate_order", "duplicate_hold", "duplicate_capture", "second_attempt", "forbidden_state_shown",
  "order_outside_subject", "progress_not_reached", "policy_mismatch", "vacuous_progress", "auto_progress_undeclared",
  "adapter_matcher_unmatched", "adapter_anchor_missing", "anchor_hidden", "control_not_applied", "arrange_failed",
  "observer_subject_unseen", "stimulus_not_create", "stimulus_not_applied", "tier_unreachable", "outcome_failed",
  "observer_failed", "page_failed", "request_budget_exceeded",
] as const;

type Open<Known extends readonly string[]> = Known[number] | (string & {});

/** An open-set string: the grammar at runtime, the known members plus `string & {}` as its type. */
export function openSet<const Known extends readonly string[]>(_known: Known, pattern: RegExp = OPEN_SET_PATTERN): z.ZodType<Open<Known>> {
  return z.string().regex(pattern) as z.ZodType<Open<Known>>;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const TAIL = `${LETTERS}0123456789_`;

function characterClass(characters: string): string {
  const parts: string[] = [];
  let start = 0;
  for (let index = 1; index <= characters.length; index += 1) {
    if (index < characters.length && characters.charCodeAt(index) === characters.charCodeAt(index - 1) + 1) continue;
    const first = characters[start]!, last = characters[index - 1]!;
    const size = index - start;
    parts.push(size === 1 ? first : size === 2 ? `${first}${last}` : `${first}-${last}`);
    start = index;
  }
  return `[${parts.join("")}]`;
}

/**
 * A portable pattern (no lookahead) that matches every open-set value except
 * `literal`: shorter strings, longer strings, and strings of the same length that
 * first differ from `literal` at position i.
 */
export function openSetExcept(literal: string): string {
  if (!OPEN_SET_PATTERN.test(literal)) throw new TypeError(`openSetExcept needs an open-set literal, got ${JSON.stringify(literal)}`);
  const length = literal.length;
  const alternatives: string[] = [];
  if (length > 1) alternatives.push(`[a-z][a-z0-9_]{0,${length - 2}}`);
  alternatives.push(`[a-z][a-z0-9_]{${length},}`);
  for (let index = 0; index < length; index += 1) {
    const allowed = (index === 0 ? LETTERS : TAIL).replace(literal[index]!, "");
    const rest = length - index - 1;
    alternatives.push(`${literal.slice(0, index)}${characterClass(allowed)}${rest > 0 ? `[a-z0-9_]{${rest}}` : ""}`);
  }
  return `^(?:${alternatives.join("|")})$`;
}

const count = z.number().int().nonnegative();
const nonEmpty = z.string().min(1);
const name = z.string().regex(OPEN_SET_PATTERN);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
// A space-separated list of hash expressions as npm writes it, holding at least one SHA-2 hash.
const HASH = String.raw`sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}(?:\?[\x21-\x7e]*)?`;
const STRONG_HASH = String.raw`sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}(?:\?[\x21-\x7e]*)?`;
const SRI = new RegExp(`^(?:${HASH} )*${STRONG_HASH}(?: ${HASH})*$`);
// A real calendar instant: month lengths, and 29 February only in leap years.
const LEAP_YEAR = String.raw`(?:\d\d(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)`;
const DATE = String.raw`(?:\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|02-(?:0[1-9]|1\d|2[0-8]))|${LEAP_YEAR}-02-29)`;
const UTC_INSTANT = new RegExp(String.raw`^${DATE}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$`);

// One UTF-16 unit of a local path: no C0 control, DEL or lone surrogate, and none of `excluded`.
// Portable: no lookaround, and correct with or without the regex `u` flag.
function pathUnit(excluded: string): string {
  return String.raw`(?:[^${excluded}\u0000-\u001f\u007f\ud800-\udfff]|[\ud800-\udbff][\udc00-\udfff])`;
}

const ledger = z.looseObject({ orders: count, payableOrders: count, holds: count, attempts: count, captures: count });

const step = z.looseObject({
  index: count,
  run: openSet(knownRuns),
  phase: openSet(knownPhases),
  action: name.nullable(),
  expectedAnchor: z.string().regex(/^state:[a-z][a-z0-9_]*$/).nullable(),
  observedAnchors: z.array(z.string().regex(/^(state|action):[a-z][a-z0-9_]*$/)),
  path: z.string().regex(/^\/[^?#]*$/).nullable(),
  elapsedMs: count,
  commands: z.array(z.looseObject({
    operation: name,
    ordinal: count,
    key: z.looseObject({ present: z.boolean(), sameAs: count.nullable() }),
  })),
  ledger: ledger.nullable(),
});

const finding = z.looseObject({
  code: openSet(knownFindingCodes),
  run: openSet(knownRuns).nullable(),
  step: count.nullable(),
  field: nonEmpty.optional(),
  observed: nonEmpty,
  cause: nonEmpty,
  fix: nonEmpty,
  recheck: nonEmpty,
});

const build = z.looseObject({
  source: openSet(knownBuildSources),
  packages: z.array(z.looseObject({ name: nonEmpty, version: nonEmpty, integrity: z.string().regex(SRI).optional() })),
  clients: z.array(z.looseObject({ name: nonEmpty, digest: z.string().regex(DIGEST) })),
  proofFile: z.string().regex(DIGEST).nullable(),
});

const harness = z.looseObject({
  runnerVersion: nonEmpty,
  catalogueVersion: z.number().int().positive(),
  adapter: z.looseObject({ kind: openSet(knownAdapterKinds), fields: z.array(nonEmpty), digest: nonEmpty.nullable() }),
  autoProgress: z.array(name),
  observer: openSet(knownObserverKinds),
  declaredOutcomes: z.array(name),
});

const width = z.number().int().positive();

/** Every channel other than `browser_ui`: `width` optional. Its type is the exported verdict type. */
export const verdictSchema = z.looseObject({
  formatVersion: z.literal(1),
  runId: nonEmpty,
  completedAt: z.string().regex(UTC_INSTANT),
  scenario: name,
  tier: openSet(knownTiers),
  profile: nonEmpty,
  channel: openSet(knownChannels, new RegExp(openSetExcept("browser_ui"))),
  width: width.optional(),
  result: openSet(knownResults),
  control: z.looseObject({ kind: openSet(knownControlKinds), action: name.optional(), negates: name.nullable(), applied: z.boolean() }),
  stimulus: z.record(name, count),
  steps: z.array(step),
  findings: z.array(finding),
  build,
  harness,
  durations: z.looseObject({ totalMs: count, byPhase: z.record(name, count) }),
});

/** The `browser_ui` channel: `width` required. */
export const browserVerdictSchema = verdictSchema.extend({ channel: z.literal("browser_ui"), width });

// Proof file, format version 1. Route paths start with `/`, not `//`; surfaces carry no query or fragment,
// a selection entry may carry a query. Module segments are non-empty and neither `.` nor `..`.
const surfacePath = z.string().regex(new RegExp(String.raw`^/(?:${pathUnit(String.raw`/\\?#`)}${pathUnit(String.raw`\\?#`)}*)?$`));
const selectionEntryPath = z.string().regex(new RegExp(String.raw`^/(?:${pathUnit(String.raw`/\\#`)}${pathUnit(String.raw`\\#`)}*)?$`));
const MODULE_SEGMENT = (() => {
  const plain = pathUnit(String.raw`/\\?#:.`), any = pathUnit(String.raw`/\\?#:`);
  return String.raw`(?:${plain}${any}*|\.${plain}${any}*|\.\.${any}+)`;
})();

export const proofFileSchema = z.looseObject({
  formatVersion: z.literal(1),
  configurations: z.array(nonEmpty).min(1),
  widths: z.array(width).min(1),
  routes: z.looseObject({
    surfaces: z.record(name, surfacePath).optional(),
    selectionEntry: z.record(name, selectionEntryPath).optional(),
  }).optional(),
  autoProgress: z.array(name).optional(),
  changedPayloadPolicy: openSet(knownChangedPayloadPolicies).optional(),
  buyer: z.looseObject({
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    phone: z.string().optional(),
    address_line1: z.string().optional(),
    address_line2: z.string().optional(),
    city: z.string().optional(),
    postal_code: z.string().optional(),
    email: z.never().optional(),
  }).optional(),
  recheck: nonEmpty.optional(),
  adapterModule: z.string().regex(new RegExp(`^${MODULE_SEGMENT}(?:/${MODULE_SEGMENT})*$`)).optional(),
  host: z.looseObject({}).optional(),
});

/** Draft-07 JSON Schema of an internal zod schema, deep-frozen so a reader cannot change the shared constant. */
export function frozenJsonSchema(schema: z.ZodType): Readonly<Record<string, unknown>> {
  return deepFreeze(z.toJSONSchema(schema, { target: "draft-07", io: "input", reused: "inline" }) as Record<string, unknown>);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** The four-part refusal both parsers return. */
export type ContractRefusal<Code extends string> = { code: Code; observed: string; cause: string; fix: string; recheck: string };

/**
 * The shared parse order: JSON text to a plain object, then `formatVersion`, then
 * the one schema `select` picks (it may refuse first, as the verdict's `channel`
 * check does). Never throws.
 */
export function parseVersionedContract<T, Invalid extends string, Unsupported extends string>(
  text: string,
  names: { subject: string; invalid: Invalid; unsupported: Unsupported; parser: string },
  select: (input: Record<string, unknown>) => z.ZodType | { path: string; message: string },
): { ok: true; value: T } | { ok: false; refusal: ContractRefusal<Invalid | Unsupported> } {
  const recheck = `Parse the ${names.subject} again with ${names.parser}.`;
  const invalid = (path: string, message: string) => ({
    ok: false as const,
    refusal: {
      code: names.invalid,
      observed: path,
      cause: `The ${names.subject} does not match format version 1 at ${path}: ${message}.`,
      fix: `Write the ${names.subject} as format version 1 and correct ${path}.`,
      recheck,
    },
  });
  let input: unknown;
  try {
    // Drop every own __proto__ key at any depth, including inside values kept as unknown fields,
    // so a reader that copies a kept value cannot have its prototype replaced.
    input = typeof text === "string" ? JSON.parse(text, (key, value: unknown) => key === "__proto__" ? undefined : value) : undefined;
  } catch {
    return invalid("(root)", "the text is not JSON");
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) return invalid("(root)", "the text is not a JSON object");
  const record = input as Record<string, unknown>;
  if (record.formatVersion !== 1) {
    const found = "formatVersion" in record ? JSON.stringify(record.formatVersion) ?? String(record.formatVersion) : "missing";
    return {
      ok: false,
      refusal: {
        code: names.unsupported,
        observed: `formatVersion ${found}`,
        cause: `This reader understands ${names.subject} format version 1 only; the ${names.subject} declares formatVersion ${found}.`,
        fix: `Read the ${names.subject} with an @openlup/platform version that supports its format, or write it as format version 1.`,
        recheck,
      },
    };
  }
  const selected = select(record);
  if (!(selected instanceof z.ZodType)) return invalid(selected.path, selected.message);
  const parsed = selected.safeParse(record);
  if (parsed.success) return { ok: true, value: parsed.data as T };
  const issue = parsed.error.issues[0]!;
  return invalid(issuePath(issue), issue.message);
}

/** Joins a zod issue path the way refusals name it (`steps.3.ledger.holds`); the root is `(root)`. */
function issuePath(issue: z.core.$ZodIssue): string {
  const path = issue.code === "unrecognized_keys" && issue.keys.length > 0 ? [...issue.path, issue.keys[0]!] : issue.path;
  return path.length === 0 ? "(root)" : path.map(String).join(".");
}
