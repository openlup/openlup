import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { allocateDiscountedGrossTotals } from "../../src/invoicing/index.js";

const fixture: { rows: { id: string; operation: string; input: unknown; expected: unknown }[] } =
  JSON.parse(readFileSync(new URL("../../../core/test/fixtures/catalogue-money.v1.json", import.meta.url), "utf8"));
const minor = z.string().regex(/^(0|[1-9]\d*)$/).transform(Number);

it.each(fixture.rows.filter(row => row.operation === "discount_allocation"))("$id (L2 invoice owner)", row => {
  const input = z.object({ lineTotalsMinor: z.array(minor), chargedTotalMinor: minor }).parse(row.input);
  const expected = z.object({ linePayablesMinor: z.array(minor) }).parse(row.expected);
  expect(allocateDiscountedGrossTotals(input.lineTotalsMinor, input.chargedTotalMinor)).toEqual(expected.linePayablesMinor);
});
