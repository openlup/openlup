import "./neutralFixtures.js";
import { describe, expect, it, vi } from "vitest";
import { COMMERCE_CONTRACT_VERSION } from "./quoteSchemaFixtures.js";
import type {
  CreateQuoteRequest,
  CreateQuoteResponse,
} from "./quoteSchemaFixtures.js";
import {
  CommerceQuoteError,
  CommerceQuoteSnapshotError,
  type CommerceQuotePort,
} from "./quoteSchemaFixtures.js";
import { createExpectedQuote } from "./snapshotFixtures.js";

const MESSAGES = {
  invalidResponseMessage: "INVALID_MSG",
  catalogMismatchMessage: "MISMATCH_MSG",
};

const REQUEST: CreateQuoteRequest = {
  mode: "one_time",
  lines: [{ sku: "ITEM-ALPHA-400", quantity: 1 }],
  promoCodes: [],
};

function portReturning(response: unknown): CommerceQuotePort {
  return { createQuote: vi.fn(async (_r: CreateQuoteRequest) => response as CreateQuoteResponse) };
}

function portThrowing(error: unknown): CommerceQuotePort {
  return {
    createQuote: vi.fn(async (_r: CreateQuoteRequest): Promise<CreateQuoteResponse> => {
      throw error;
    }),
  };
}

function validResponse(): CreateQuoteResponse {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    quote: {
      currency: "XXX",
      taxIncluded: true,
      lines: [
        {
          sku: "ITEM-ALPHA-400",
          productSlug: "item-alpha",
          quantity: 1,
          unitPriceGross: { amountMinor: 1490, currency: "XXX" },
          lineSubtotalGross: { amountMinor: 1490, currency: "XXX" },
          tax: {
            included: true,
            country: "ZZ",
            category: "example_category",
            vatRateBps: 800,
            legalBasis: "Example VAT rule",
            netAmount: { amountMinor: 1380, currency: "XXX" },
            vatAmount: { amountMinor: 110, currency: "XXX" },
            grossAmount: { amountMinor: 1490, currency: "XXX" },
          },
        },
      ],
      discounts: [],
      subtotalGross: { amountMinor: 1490, currency: "XXX" },
      discountTotalGross: { amountMinor: 0, currency: "XXX" },
      totalGross: { amountMinor: 1490, currency: "XXX" },
      netTotal: { amountMinor: 1380, currency: "XXX" },
      taxTotal: { amountMinor: 110, currency: "XXX" },
    },
  };
}

describe("createExpectedQuote", () => {
  it("returns the parsed quote on a valid response", async () => {
    const expected = await createExpectedQuote(portReturning(validResponse()), REQUEST, MESSAGES);
    expect(expected.quote.lines[0].sku).toBe("ITEM-ALPHA-400");
  });

  it("wraps a schema-invalid response with the supplied invalidResponseMessage", async () => {
    await expect(
      createExpectedQuote(
        portReturning({ contractVersion: COMMERCE_CONTRACT_VERSION, quote: {} }),
        REQUEST,
        MESSAGES,
      ),
    ).rejects.toMatchObject({
      name: "CommerceQuoteSnapshotError",
      message: "INVALID_MSG",
      details: { reason: "invalid_expected_quote" },
    });
  });

  it("wraps a CommerceQuoteError with the supplied catalogMismatchMessage, preserving code + details", async () => {
    const port = portThrowing(
      new CommerceQuoteError("UNKNOWN_SKU", "nope", { sku: "ITEM-BETA-400" }),
    );
    await expect(createExpectedQuote(port, REQUEST, MESSAGES)).rejects.toMatchObject({
      name: "CommerceQuoteSnapshotError",
      message: "MISMATCH_MSG",
      details: { reason: "UNKNOWN_SKU", sku: "ITEM-BETA-400" },
    });
  });

  it("rethrows an existing CommerceQuoteSnapshotError unchanged", async () => {
    const original = new CommerceQuoteSnapshotError("QUOTE_SNAPSHOT_MISMATCH", "orig", {
      reason: "x",
    });
    await expect(createExpectedQuote(portThrowing(original), REQUEST, MESSAGES)).rejects.toBe(
      original,
    );
  });

  it("rethrows an unrelated error unchanged", async () => {
    const boom = new Error("boom");
    await expect(createExpectedQuote(portThrowing(boom), REQUEST, MESSAGES)).rejects.toBe(boom);
  });
});
