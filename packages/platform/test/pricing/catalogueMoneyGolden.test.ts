import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { calculateIncludedVat, createCommerceQuoteSchemas, splitIncludedVat } from "../../src/pricing/index.js";

const { commerceQuoteSchema } = createCommerceQuoteSchemas({
  currencySchema: z.literal("XXX"), productSlugSchema: z.string().min(1), contextSchema: z.object({}),
});

const fixture: { rows: { id: string; operation: string; input: unknown; expected: unknown }[] } =
  JSON.parse(readFileSync(new URL("../../../core/test/fixtures/catalogue-money.v1.json", import.meta.url), "utf8"));
const minor = z.string().regex(/^(0|[1-9]\d*)$/).transform(Number);
const amounts = { grossMinor: minor, netMinor: minor, vatMinor: minor };

it.each(fixture.rows.filter(row => row.operation === "included_vat"))("$id (L2 quote owners)", row => {
  const input = z.object({ grossMinor: minor, vatRateBps: minor }).parse(row.input);
  const expected = z.object({ netMinor: minor, vatMinor: minor }).parse(row.expected);
  expect(calculateIncludedVat(input.grossMinor, input.vatRateBps)).toEqual(expected);
  expect(splitIncludedVat(input.grossMinor, input.vatRateBps)).toEqual(expected);
});

it.each(fixture.rows.filter(row => row.operation === "legacy_quote"))("$id (L2 quote refusal)", row => {
  const input = z.object({ ...amounts, currency: z.string(),
    lines: z.array(z.object({ ...amounts, vatRateBps: minor })),
  }).parse(row.input);
  const money = (amountMinor: number) => ({ amountMinor, currency: input.currency });
  const quote = {
    currency: input.currency, taxIncluded: true,
    lines: input.lines.map((line, index) => ({
      sku: `EXAMPLE-${index}`, productSlug: `item-${index}`, quantity: 1,
      unitPriceGross: money(line.grossMinor), lineSubtotalGross: money(line.grossMinor),
      tax: { included: true, country: "ZZ", category: "standard", legalBasis: "Example VAT rule",
        vatRateBps: line.vatRateBps, netAmount: money(line.netMinor), vatAmount: money(line.vatMinor),
        grossAmount: money(line.grossMinor) },
    })),
    discounts: [], subtotalGross: money(input.grossMinor), discountTotalGross: money(0),
    totalGross: money(input.grossMinor), netTotal: money(input.netMinor), taxTotal: money(input.vatMinor),
  };
  const expected = z.object({ success: z.literal(false),
    issue: z.object({ path: z.array(z.string()), message: z.string() }),
  }).parse(row.expected);
  const result = commerceQuoteSchema.safeParse(quote);
  expect(result.success).toBe(expected.success);
  if (!result.success) {
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toContainEqual(expected.issue);
  }
});
