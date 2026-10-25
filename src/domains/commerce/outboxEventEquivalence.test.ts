import { expect, it } from "vitest";
import capturedCases from "./outboxEventEquivalence.fixture.json";
import * as events from "./outboxEventContracts.js";

import { PLATFORM_DEFAULT_CURRENCY, PLATFORM_DEFAULT_REGION } from "../../lib/currency/platformCurrency.js";

// Captured fiscal values are bound to the selected reference profile at test time.
const cases = JSON.parse(JSON.stringify(capturedCases).replace(/__HOST_CURRENCY__/g, PLATFORM_DEFAULT_CURRENCY)
  .replace(/__HOST_COUNTRY__/g, PLATFORM_DEFAULT_REGION)) as typeof capturedCases;

// Captured against BASE before extraction: exact host snapshot fields and nested issues.
it.each(cases)("preserves the host-bound $schema output and refusal", ({ schema, input, expected }) => {
  const validator = (events as unknown as Record<string, { safeParse(value: unknown):
    { success: boolean; data?: unknown; error?: { issues: unknown } } }>)[schema];
  const parsed = validator.safeParse(input);
  expect(parsed.success ? { success: true, data: parsed.data } : { success: false, issues: parsed.error!.issues }).toEqual(expected);
});
