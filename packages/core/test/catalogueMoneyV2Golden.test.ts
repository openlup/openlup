import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { calculateCatalogueMoneyV2 } from "@openlup/core/pricing";

const minor = z.string().max(16).regex(/^(0|[1-9][0-9]*)$/)
  .refine(value => Number.isSafeInteger(Number(value)) && String(Number(value)) === value)
  .transform(Number);
const text = z.string().min(1).max(128);
const basis = z.enum(["inclusive", "exclusive"]);
const rateDecimal = z.string().regex(/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,6})?$/);
const ref = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("merchandise"), lineKey: text, sourceOrdinal: minor }),
  z.strictObject({ kind: z.literal("delivery"), bucketKey: text, sourceOrdinal: minor.optional() }),
]);
const fee = z.strictObject({ feeKey: text, amountMinor: minor });
const input = z.strictObject({
  amountBasis: basis,
  sources: z.array(z.strictObject({ lineKey: text, sourceOrdinal: minor, quantity: minor, unitBasisMinor: minor })).max(256),
  delivery: z.array(z.strictObject({ bucketKey: text, deliveryKind: z.enum(["shipping", "handling"]), amountMinor: minor })).max(256),
  adjustments: z.array(z.strictObject({
    adjustmentRef: text, sequence: minor, amountMinor: minor,
    target: z.union([z.strictObject({ lineKeys: z.array(text).max(256) }), z.strictObject({ bucketKey: text })]),
  })).max(256),
  fees: z.array(fee).max(256),
});
const position = z.strictObject({
  positionRef: text, jurisdictionRef: text, rateDecimal: rateDecimal.optional(), taxableMinor: minor, taxMinor: minor,
});
const tax = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("inclusive"), components: z.array(z.strictObject({ ref, rateBps: minor })).max(512) }),
  z.strictObject({
    kind: z.literal("local"), components: z.array(z.strictObject({
      ref, rates: z.array(z.strictObject({ positionRef: text, jurisdictionRef: text, rateDecimal })).max(32),
    })).max(512),
  }),
  z.strictObject({
    kind: z.literal("provider"), payableMinor: minor, components: z.array(z.strictObject({
      ref, states: z.array(z.strictObject({
        afterSequence: minor, amountMinor: minor, taxPositions: z.array(position).max(32),
      })).max(257),
    })).max(512),
  }),
]);
const state = z.strictObject({
  amountMinor: minor, netMinor: minor, taxMinor: minor, totalMinor: minor, taxPositions: z.array(position).max(32),
});
const result = z.strictObject({
  amountBasis: basis,
  components: z.array(z.strictObject({
    ref, initial: state, final: state,
    allocations: z.array(z.strictObject({
      adjustmentRef: text, sequence: minor, basisReductionMinor: minor, beforeMinor: minor, afterMinor: minor,
      before: state, after: state, netReductionMinor: minor, taxReductionMinor: minor,
    })).max(256),
  })).max(767),
  fees: z.array(fee).max(256), netTotal: minor, taxTotal: minor, feeTotal: minor, payableMinor: minor,
});
const refusal = z.strictObject({ error: z.strictObject({
  code: z.enum([
    "money_input_invalid", "money_amount_out_of_range", "money_amount_basis_mixed",
    "money_source_ordinal_duplicate", "money_discount_exceeds_balance", "shipping_tax_basis_empty",
    "money_rate_invalid", "money_tax_evidence_mismatch", "money_payable_mismatch",
  ]),
  field: text,
}) });
const caseSchema = z.strictObject({ name: text, input, tax, expected: z.union([result, refusal]) });
const rowSchema = z.strictObject({ id: text, cases: z.array(caseSchema).min(1).max(32) })
  .refine(row => new Set(row.cases.map(scenario => scenario.name)).size === row.cases.length, "duplicate case name");
const fixtureSchema = z.strictObject({ version: z.literal("2"), rows: z.array(rowSchema).min(1).max(32) })
  .refine(fixture => new Set(fixture.rows.map(row => row.id)).size === fixture.rows.length, "duplicate row id");

const fixturePath = new URL("./fixtures/catalogue-money.v2.json", import.meta.url);
if (statSync(fixturePath).size > 64 * 1024) throw new Error("Keep the catalogue money fixture within 64 KiB.");
const raw = readFileSync(fixturePath, "utf8");
const { rows } = fixtureSchema.parse(JSON.parse(raw));
const scenarios = rows.flatMap(row => row.cases.map(scenario => ({ id: row.id, ...scenario })));

describe("catalogue money v2 golden fixture", () => {
  it.each(scenarios)("$id / $name", ({ input, tax, expected }) => {
    if ("error" in expected) {
      const { code, field } = expected.error;
      expect(() => calculateCatalogueMoneyV2(input, tax)).toThrow(expect.objectContaining({
        name: "CatalogueMoneyV2Error", code, field, remedy: expect.stringMatching(/^[A-Z].+\.$/),
        message: expect.stringContaining(`${code} at ${field}. `),
      }));
      return;
    }
    const actual = calculateCatalogueMoneyV2(input, tax);
    expect(actual).toStrictEqual(expected);
    expect(actual.fees).toStrictEqual(input.fees);
    for (const component of actual.components) {
      let previous = component.initial;
      for (const allocation of component.allocations) {
        expect(allocation.before).toBe(previous);
        previous = allocation.after;
      }
      expect(component.final).toBe(previous);
    }
  });

  it.each([
    ["an extra key", (fixture: WireFixture) => Object.assign(fixture.rows[0].cases[0].input, { extra: true })],
    ["a duplicate row id", (fixture: WireFixture) => fixture.rows.push(fixture.rows[0])],
    ["a duplicate case name", (fixture: WireFixture) => fixture.rows[0].cases.push(fixture.rows[0].cases[0])],
    ["a numeric amount", (fixture: WireFixture) => Object.assign(fixture.rows[0].cases[0].input.sources[0], { unitBasisMinor: 540 })],
    ["an unsafe decimal", (fixture: WireFixture) => { fixture.rows[0].cases[0].input.sources[0].unitBasisMinor = "9007199254740992"; }],
    ["a noncanonical decimal", (fixture: WireFixture) => { fixture.rows[0].cases[0].input.sources[0].unitBasisMinor = "0540"; }],
  ] as const)("rejects %s", (_name, mutate) => {
    const fixture = JSON.parse(raw) as WireFixture;
    mutate(fixture);
    expect(fixtureSchema.safeParse(fixture).success).toBe(false);
  });
});

type WireFixture = z.input<typeof fixtureSchema>;
