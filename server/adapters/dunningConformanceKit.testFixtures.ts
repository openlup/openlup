// The dunning conformance kit (Provider Entry Gate, F1; audit of 2026-08-09).
//
// Its own file so the kit can be pointed at by name. `.testFixtures.ts` keeps
// vitest from collecting it as a standalone suite; it is run from
// `describeUnattendedChargeConformance`, once per conformance subject.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PaymentExecutionBaseInput } from "@openlup/core/testing";
import { classifyDecline } from "../shared/finalizeDeclinedAttempt.js";
import type {
  paymentExecutionContractInput,
  UnattendedChargeConformanceSubject,
  UnattendedChargeResult,
} from "./paymentExecutionPortContract.testFixtures.js";

/**
 * The dunning conformance kit: the four scenarios the audit of 2026-08-09 made
 * mandatory, as ONE named table instead of assertions scattered over five files.
 *
 * Each entry is either PORT-CARRIED (runnable here, against every subject, from
 * a refusal the subject's own fake produces) or SEAM-SPECIFIC, meaning the
 * behaviour lives at a write this fixture has no port for (a preflight record, a
 * reconciliation column, a table of persisted reasons). A seam entry does not get
 * a weaker restatement here; it DELEGATES, naming the suite that carries it, and
 * the kit fails if that suite stops carrying it.
 *
 * A pin is addressed by DIRECTORY plus test title, never by file path. Two
 * reasons, both load-bearing: three of the carrier file names are counted
 * provider vocabulary and this table must stay neutral, and a title search
 * survives a file rename while still failing loudly on a deleted or reworded
 * pin, which is the failure this delegation exists to catch.
 */
export type DunningConformanceScenarioId =
  | "mandate_unfit_preflight"
  | "reconciliation_discovered_decline"
  | "webhook_less_rail"
  | "every_persisted_preflight_reason";

export interface DunningConformanceSeamPin {
  /** Repository directory whose suites are searched. Never a file path. */
  readonly directory: string;
  /** The exact test title that carries this scenario, as written today. */
  readonly title: string;
}

export interface DunningConformanceScenario {
  readonly id: DunningConformanceScenarioId;
  readonly name: string;
  /** What the kit demands, in the audit's own terms. */
  readonly demand: string;
  readonly carriedBy: "port" | "seam";
  /** Empty for a port-carried entry; at least one pin for a seam entry. */
  readonly delegatesTo: readonly DunningConformanceSeamPin[];
}

export const DUNNING_CONFORMANCE_SCENARIOS: readonly DunningConformanceScenario[] = [
  {
    id: "mandate_unfit_preflight",
    name: "a mandate too unfit to charge unattended is refused with a class that names the cause",
    demand: "the refusal classifies as something other than `indeterminate`, on the attempt and on the case alike, and reaches the payer as a sentence",
    carriedBy: "seam",
    // The write happens before any provider call, so no execution port can
    // produce it. The propagation seam is where the class is stamped.
    delegatesTo: [
      {
        directory: "server/domains/subscription",
        title: "records `mandate_dead` decided by the hint, on the attempt and on the case alike",
      },
      {
        directory: "server/domains/subscription",
        title: "reaches the payer as the sentence naming the cause",
      },
    ],
  },
  {
    id: "reconciliation_discovered_decline",
    name: "a decline discovered by reconciliation rather than by execute() keeps its code and its class",
    demand: "the refusal the poller finds is read as a refusal, and both the code and the class it reads as survive into the terminal write",
    carriedBy: "seam",
    // Three pins because the path has three joints and each one dropped the
    // class at some point in this programme: the adapter's reading of the
    // readback, the worker's composition of the terminal call, and the SQL
    // contract that call travels.
    delegatesTo: [
      {
        directory: "server/adapters",
        title: "keeps the code the transport parsed, and the class it reads as",
      },
      {
        directory: "server/domains/payment",
        title: "%s: composes a terminal failure carrying the adapter's class",
      },
      {
        directory: "server/adapters",
        title: "forwards a supplied classification into both SQL parameters",
      },
    ],
  },
  {
    id: "webhook_less_rail",
    name: "a rail whose refusal is never followed by a callback still names a cause",
    demand: "`webhookExpected` may be false, and the class must be neither `indeterminate` nor reached by default",
    carriedBy: "port",
    delegatesTo: [],
  },
  {
    id: "every_persisted_preflight_reason",
    name: "every persisted preflight reason carries a neutral hint",
    demand: "no customer-facing preflight reason classifies as the one cause that means `add no sentence at all`",
    carriedBy: "seam",
    delegatesTo: [
      {
        directory: "server/domains/subscription",
        title: "leaves no customer-facing reason without a cause the payer may be told",
      },
      {
        directory: "server/domains/subscription",
        title: "%s classifies exactly as the table says",
      },
    ],
  },
];

const suiteCache = new Map<string, readonly { path: string; text: string }[]>();

/** Every suite source under `directory`, read once per process. */
function suitesUnder(directory: string): readonly { path: string; text: string }[] {
  const cached = suiteCache.get(directory);
  if (cached) return cached;
  const found: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      // `.testFixtures.ts` counts: a kit whose own scenarios live in a fixture
      // would otherwise be unable to pin itself.
      else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".testFixtures.ts")) {
        found.push({ path, text: readFileSync(path, "utf8") });
      }
    }
  };
  walk(directory);
  suiteCache.set(directory, found);
  return found;
}

// This file spells every pinned title itself, in the table above, and one of the
// searched directories contains it. Excluding the manifest from its own search is
// what keeps "exactly one carrier" meaning a real suite rather than the table
// finding its own reflection.
const MANIFEST_SOURCE = "dunningConformanceKit.testFixtures.ts";

/** The suites under `pin.directory` that still spell `pin.title`. */
export function suitesCarryingPin(pin: DunningConformanceSeamPin): readonly string[] {
  return suitesUnder(pin.directory)
    .filter((suite) => !suite.path.endsWith(MANIFEST_SOURCE) && suite.text.includes(pin.title))
    .map((suite) => suite.path);
}

interface PortCarriedContext<
  TInput extends PaymentExecutionBaseInput,
  TResult extends UnattendedChargeResult,
> {
  subject: UnattendedChargeConformanceSubject<TInput, TResult>;
  chargeInput: () => TInput;
}

type PortCarriedAssertion = <
  TInput extends PaymentExecutionBaseInput,
  TResult extends UnattendedChargeResult,
>(context: PortCarriedContext<TInput, TResult>) => Promise<void>;

/**
 * The port-carried half of the kit. Keyed by scenario id rather than positional,
 * so a port entry added to the table without a body fails on its own row instead
 * of silently passing.
 */
const PORT_CARRIED: Partial<Record<DunningConformanceScenarioId, PortCarriedAssertion>> = {
  // Audit scenario 3 of 2026-08-09, landed GREEN by the red half of this PR.
  // Asserted beside the webhook promise itself, because "no webhook" and "no
  // class" would otherwise be one silence no reader can tell apart. The class is
  // read through `classifyDecline`, the one seam every execution rail's refusal
  // travels, so a subject that satisfies this proves the whole path.
  webhook_less_rail: async ({ subject, chargeInput }) => {
    const result = await subject.createSoftDecliningPort().execute(chargeInput());
    const decline = result.providerDecline;
    expect(decline).toBeTruthy();
    const classification = classifyDecline(decline!);

    expect(result.webhookExpected).toBe(false);
    // Both halves, because either alone is satisfiable by accident: a class that
    // says nothing, or a class reached by falling off the end of the evidence
    // tiers rather than by reading this subject's own refusal.
    expect(classification.failureClass).not.toBe("indeterminate");
    expect(classification.decidedBy).not.toBe("default");
  },
};

/**
 * Runs the kit for one conformance subject. Nested inside
 * {@link describeUnattendedChargeConformance}, so it runs against every subject
 * that suite already has: the two shipped rails and the template provider that
 * belongs to no deployment.
 */
export function describeDunningConformanceKit<
  TInput extends PaymentExecutionBaseInput = typeof paymentExecutionContractInput,
  TResult extends UnattendedChargeResult = UnattendedChargeResult,
>(
  subject: UnattendedChargeConformanceSubject<TInput, TResult>,
  chargeInput: () => TInput,
): void {
  describe("dunning conformance kit (audit of 2026-08-09)", () => {
    for (const scenario of DUNNING_CONFORMANCE_SCENARIOS) {
      if (scenario.carriedBy === "seam") {
        it(`${scenario.name}: the seam suite this kit names still carries it`, () => {
          expect(scenario.delegatesTo.length).toBeGreaterThan(0);
          for (const pin of scenario.delegatesTo) {
            // Exactly one: zero means the pin moved or was reworded, two means
            // the proof was copied and the copies can now disagree.
            expect(suitesCarryingPin(pin), `${pin.directory} :: ${pin.title}`).toHaveLength(1);
          }
        });
        continue;
      }

      const assertion = PORT_CARRIED[scenario.id];
      it(`${scenario.name}: holds against this subject's own refusal`, async () => {
        expect(assertion, scenario.id).toBeTruthy();
        await assertion!({ subject, chargeInput });
      });
    }
  });
}
