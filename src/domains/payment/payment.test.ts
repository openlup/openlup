import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PAYMENT_FAILURE_CLASSES } from "@openlup/core/payment";
import {
  PAYMENT_EXECUTION_ATTEMPT_STATUSES,
  PAYMENT_EXECUTION_MODES,
} from "./executionBaseContracts.js";
import {
  PAYMENT_EXECUTION_PROVIDERS,
  PAYMENT_NEXT_ACTION_KINDS,
  PAYMENT_SESSION_STATES,
} from "./types.js";
import { PaymentProviderNotConfiguredError } from "./ports.js";
import {
  LIVE_ATTEMPT_STATUSES,
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_CONTROL_EVENT_TYPES,
  PAYMENT_INTENT_STATUSES,
  PAYMENT_TARGET_KINDS,
  RETRYABLE_ATTEMPT_STATUSES,
  isLiveAttemptStatus,
  isRetryableAttemptStatus,
  providerAckedButNeverConfirmed,
} from "./paymentControlTypes.js";

describe("payment domain primitives", () => {
  it("exposes the canonical PaymentSession state machine", () => {
    expect(PAYMENT_SESSION_STATES).toEqual([
      "requires_action",
      "pending",
      "succeeded",
      "failed",
      "cancelled",
    ]);
  });

  it("exposes the canonical next_action_kinds (PL BLIK + 3DS + redirect)", () => {
    expect(PAYMENT_NEXT_ACTION_KINDS).toEqual([
      "redirect",
      "3ds_challenge",
      "qr_code",
      "blik_code_prompt",
      "sca_required",
    ]);
  });

  it("PaymentProviderNotConfiguredError carries the provider_kind that needs an adapter", () => {
    const error = new PaymentProviderNotConfiguredError("mollie");
    expect(error.name).toBe("PaymentProviderNotConfiguredError");
    expect(error.message).toContain("mollie");
  });

  it("exposes payment-control intent, attempt, target, and event enums", () => {
    expect(PAYMENT_TARGET_KINDS).toEqual(["one_time_order", "subscription_cycle"]);
    expect(PAYMENT_INTENT_STATUSES).toEqual([
      "created",
      "requires_action",
      "processing",
      "succeeded",
      "failed",
      "expired",
      "cancelled",
      "refunded",
      "partially_refunded",
      "disputed",
    ]);
    expect(PAYMENT_ATTEMPT_STATUSES).toEqual([
      "created",
      "blocked_preflight",
      "sent_to_provider",
      "requires_action",
      "processing",
      "succeeded",
      "failed",
      "cancelled",
      "expired",
    ]);
    expect(PAYMENT_CONTROL_EVENT_TYPES).toContain("payment.disputed");
    expect(PAYMENT_EXECUTION_PROVIDERS).toEqual(["hidden_rehearsal", "noop_payment", "stripe", "tpay"]);
  });

  it("exposes provider-neutral payment execution base primitives", () => {
    expect(PAYMENT_EXECUTION_MODES).toEqual(["one_time", "subscription_cycle"]);
    expect(PAYMENT_EXECUTION_ATTEMPT_STATUSES).toEqual([
      "sent_to_provider",
      "requires_action",
      "processing",
    ]);
    for (const status of PAYMENT_EXECUTION_ATTEMPT_STATUSES) {
      expect(PAYMENT_ATTEMPT_STATUSES).toContain(status);
    }
  });
});

/**
 * The payment status canon. Prose about these statuses lives in
 * `docs/PAYMENT_STATUS_CANON.md`; this is the half a document cannot do.
 *
 * Every constant above is a copy of a decision that is actually enforced in SQL:
 * a CHECK constraint decides which status values a row may hold, and one function
 * body decides which of them still permit a second provider call. A TypeScript
 * array that drifts from either does not fail — it silently disagrees with the
 * database, and the disagreement shows up as a payer told the wrong thing about
 * their money. That is the shape of the 2026-08-27 checkout dead end: the verdict
 * and the reasoning behind it lived in different files, and neither could see the
 * other. `docs/PAYMENT_STATUS_CANON.md` carries the incident reference.
 *
 * So these tests read the tracked SQL and compare. They never generate SQL: the
 * migrations stay the authority, and a mismatch is reported rather than papered
 * over.
 */
describe("payment status canon (TypeScript vocabularies against the DB CHECKs)", () => {
  it("PAYMENT_ATTEMPT_STATUSES is exactly the attempt status CHECK", () => {
    expect(PAYMENT_ATTEMPT_STATUSES).toEqual(latestCheckValues({
      constraint: "commerce_payment_attempts_status_check",
      column: "status",
    }));
  });

  // The intent CHECK has no ADD CONSTRAINT anywhere: its only definition is
  // inline in the CREATE TABLE. Hence the reader below accepts both forms — and
  // a later migration that does replace this one with an ADD CONSTRAINT is
  // picked up without editing this test.
  it("PAYMENT_INTENT_STATUSES is exactly the intent status CHECK", () => {
    expect(PAYMENT_INTENT_STATUSES).toEqual(latestCheckValues({
      table: "commerce_payment_intents",
      column: "status",
    }));
  });

  it("PAYMENT_FAILURE_CLASSES is exactly both failure_class CHECKs", () => {
    const attempts = latestCheckValues({
      constraint: "commerce_payment_attempts_failure_class_check",
      column: "failure_class",
    });
    const dunningCases = latestCheckValues({
      constraint: "subscription_dunning_cases_failure_class_check",
      column: "failure_class",
    });
    // Two tables, one vocabulary. They were added in one migration and have
    // drifted apart nowhere yet; this is the assertion that keeps it that way.
    expect(attempts).toEqual(dunningCases);
    expect([...PAYMENT_FAILURE_CLASSES]).toEqual(attempts);
  });

  /**
   * The admission gate. `commerce_payment_control_prepare_provider_attempt` is
   * the only thing standing between a retry and a second charge, and it decides
   * with a `status NOT IN (...)` list written by hand at three places across its
   * definitions — one in the migration that introduced the in-flight guard, two
   * in the migration that currently owns the function body.
   *
   * Every one of those lists must be this constant. A full-body replace of this
   * function that retypes the list slightly differently is precisely the change
   * that would open the gate by one status without anyone noticing, and it is
   * what this assertion exists to stop.
   */
  it("the provider-attempt gate names exactly RETRYABLE_ATTEMPT_STATUSES, in every definition", () => {
    const lists = gateStatusExclusionLists("public.commerce_payment_control_prepare_provider_attempt");

    // Source history contains the introducing site plus two live-body sites. A
    // flattened pg_dump baseline intentionally contains only the two live sites.
    expect(lists.length).toBeGreaterThanOrEqual(isFlattenedBaseline() ? 2 : 3);
    for (const site of lists) {
      expect(site.statuses, `gate list at ${site.file}:${site.line}`)
        .toEqual([...RETRYABLE_ATTEMPT_STATUSES]);
    }
    // The live body — the latest definition — must still carry a gate at all.
    // Without this, a replacement that DROPPED the check would pass on the
    // strength of the historical copies alone.
    const latestFile = lists[lists.length - 1]?.file;
    expect(lists.filter((site) => site.file === latestFile).length).toBeGreaterThanOrEqual(1);
  });

  it("the two attempt-status predicates partition the vocabulary, with succeeded outside both", () => {
    for (const status of PAYMENT_ATTEMPT_STATUSES) {
      // Neither predicate is the other's complement: `succeeded` is settled, so
      // it is not live, and it is not retryable either — a succeeded attempt
      // must never admit a second provider call. Every other status is in
      // exactly one of the two sets.
      expect(
        [isRetryableAttemptStatus(status), isLiveAttemptStatus(status)],
        `predicate verdicts for ${status}`,
      ).toEqual(status === "succeeded" ? [false, false] : [
        !isLiveAttemptStatus(status),
        !isRetryableAttemptStatus(status),
      ]);
      expect(!isRetryableAttemptStatus(status)).toBe(isLiveAttemptStatus(status) || status === "succeeded");
    }
    expect([...RETRYABLE_ATTEMPT_STATUSES, ...LIVE_ATTEMPT_STATUSES, "succeeded"].sort())
      .toEqual([...PAYMENT_ATTEMPT_STATUSES].sort());
  });

  it("providerAckedButNeverConfirmed names the one status that claims neither too much nor too little", () => {
    const named = PAYMENT_ATTEMPT_STATUSES.filter(providerAckedButNeverConfirmed);
    expect(named).toEqual(["sent_to_provider"]);
    // It is live, so pollers and watchdogs see it, and it is not retryable, so
    // the gate stays closed while the outcome is unknown. Both halves matter:
    // the incident mapping reached `processing`, which is also live and also
    // fail-closed, and was wrong only in what it told the payer.
    expect(isLiveAttemptStatus("sent_to_provider")).toBe(true);
    expect(isRetryableAttemptStatus("sent_to_provider")).toBe(false);
  });
});

const MIGRATIONS_DIR = join(process.cwd(), "supabase/migrations");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
}

function quotedLiterals(list: string): string[] {
  return Array.from(list.matchAll(/'([^']*)'/g)).map((match) => {
    const value = match[1];
    if (!value) throw new Error(`Malformed literal in CHECK list: ${list}`);
    return value;
  });
}

function checkLists(source: string, column: string): string[][] {
  const expression = new RegExp(
    `\\b${column}\\b\\s*(?:IN\\s*\\(([^)]*)\\)|=\\s*ANY\\s*\\(\\s*ARRAY\\[([^\\]]*)\\]\\s*\\))`,
    "gi",
  );
  return [...source.matchAll(expression)].map((match) => quotedLiterals(match[1] ?? match[2] ?? ""));
}

function namedConstraintBody(source: string, constraint: string): string | null {
  const start = source.search(new RegExp(`(?:ADD\\s+)?CONSTRAINT\\s+${constraint}\\s+CHECK`, "i"));
  if (start < 0) return null;
  const rest = source.slice(start);
  const end = rest.indexOf(";");
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * The values a column's newest CHECK admits, read out of the tracked migrations.
 *
 * The column-aware and form-aware sibling of `latestStatusCheckValues` in
 * `src/domains/subscription/subscription.test.ts`. It is a sibling rather than a
 * shared import because hoisting it would cost a new module this wave has no
 * budget for, and because only this caller needs the inline `CREATE TABLE` form.
 * A third caller should merge the two.
 *
 * Two shapes are accepted, and the later migration wins regardless of which
 * shape it used:
 *
 * - `ADD CONSTRAINT <constraint> CHECK (<column> IN (...))`, optionally with a
 *   leading `<column> IS NULL OR` for a nullable column.
 * - an inline `CHECK (<column> IN (...))` on the column inside
 *   `CREATE TABLE ... <table>`.
 */
function latestCheckValues(
  target: { column: string } & ({ constraint: string } | { table: string }),
): string[] {
  const { column } = target;
  const label = "constraint" in target ? target.constraint : `${target.table}.${column}`;

  let latest: string[] | null = null;
  for (const file of migrationFiles()) {
    const source = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const scoped = "constraint" in target
      ? namedConstraintBody(source, target.constraint)
      : createTableBody(source, target.table);
    const lists = scoped ? checkLists(scoped, column) : [];
    if (lists.length > 0) latest = lists[lists.length - 1] ?? null;
  }

  if (!latest || latest.length === 0) throw new Error(`No CHECK values found for ${label}`);
  return latest;
}

function isFlattenedBaseline(): boolean {
  const files = migrationFiles();
  return files.length === 1 && files[0] === "00000000000000_platform_schema_baseline.sql";
}

/** The `CREATE TABLE` body for one table, so an inline CHECK cannot be read off a neighbour. */
function createTableBody(source: string, table: string): string | null {
  // The table name is anchored immediately after `CREATE TABLE`, not searched
  // for loosely: a lazy span would happily run from an earlier table's header to
  // this name appearing in one of its REFERENCES clauses and then read the wrong
  // table's columns.
  const start = source.search(new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:public\\.)?${table}\\s*\\(`,
    "i",
  ));
  if (start < 0) return null;
  const rest = source.slice(start);
  const end = rest.search(/\n\s*(?:CREATE|ALTER|COMMENT|DROP|GRANT|REVOKE)\b/i);
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * Every `<alias>.status NOT IN (...)` list inside every definition of one SQL
 * function, oldest definition first.
 *
 * Scoped to the named function on purpose. The repository has well over a
 * hundred `status NOT IN (...)` lists across its migrations, most of them about
 * orders, fulfillments or subscriptions, and several of them happen to hold only
 * values that are also payment attempt statuses. A value-shaped filter would
 * pick those up and pin unrelated tables to a payment constant.
 */
function gateStatusExclusionLists(
  functionName: string,
): Array<{ file: string; line: number; statuses: string[] }> {
  const sites: Array<{ file: string; line: number; statuses: string[] }> = [];
  const definition = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${functionName.replace(".", "\\.")}\\s*\\(`,
    "gi",
  );
  const exclusion = /\b[A-Za-z_][A-Za-z0-9_]*\.status\s+NOT\s+IN\s*\(\s*((?:'[^']*'\s*,?\s*)+)\)/gi;

  for (const file of migrationFiles()) {
    const source = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const header of source.matchAll(definition)) {
      const tail = source.slice(header.index);
      const opening = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(tail);
      const delimiter = opening?.[1];
      if (!opening || !delimiter) throw new Error(`Malformed function body for ${functionName} in ${file}`);
      const bodyStart = header.index + opening.index + opening[0].length;
      const bodyEnd = source.indexOf(delimiter, bodyStart);
      if (bodyEnd < 0) throw new Error(`Unclosed function body for ${functionName} in ${file}`);
      const body = source.slice(bodyStart, bodyEnd);
      for (const match of body.matchAll(exclusion)) {
        const list = match[1];
        if (!list) continue;
        sites.push({
          file,
          line: source.slice(0, bodyStart + match.index).split("\n").length,
          statuses: quotedLiterals(list),
        });
      }
    }
  }

  if (sites.length === 0) throw new Error(`No status exclusion list found in ${functionName}`);
  return sites;
}
