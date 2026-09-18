import { describe, expect, it, vi } from "vitest";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import type {
  CreateQuoteRequest,
  CreateQuoteResponse,
} from "../../../src/domains/commerce/contracts.js";
import {
  CommerceQuoteError,
  CommerceQuoteSnapshotError,
  type CommerceQuotePort,
} from "../../../src/domains/commerce/ports.js";
import { createExpectedQuote } from "./commerceQuoteSnapshotExpect.js";

const MESSAGES = {
  invalidResponseMessage: "INVALID_MSG",
  catalogMismatchMessage: "MISMATCH_MSG",
};

const REQUEST: CreateQuoteRequest = {
  mode: "one_time",
  lines: [{ sku: "OPENLUP-DOG-LAMB-CAN-400G", quantity: 1 }],
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
      currency: "PLN",
      taxIncluded: true,
      lines: [
        {
          sku: "OPENLUP-DOG-LAMB-CAN-400G",
          productSlug: "lamb",
          quantity: 1,
          unitPriceGross: { amountMinor: 1490, currency: "PLN" },
          lineSubtotalGross: { amountMinor: 1490, currency: "PLN" },
          tax: {
            included: true,
            country: "PL",
            category: "pet_food",
            vatRateBps: 800,
            legalBasis: "PL VAT Annex 3 item 10c",
            netAmount: { amountMinor: 1380, currency: "PLN" },
            vatAmount: { amountMinor: 110, currency: "PLN" },
            grossAmount: { amountMinor: 1490, currency: "PLN" },
          },
        },
      ],
      discounts: [],
      subtotalGross: { amountMinor: 1490, currency: "PLN" },
      discountTotalGross: { amountMinor: 0, currency: "PLN" },
      totalGross: { amountMinor: 1490, currency: "PLN" },
      netTotal: { amountMinor: 1380, currency: "PLN" },
      taxTotal: { amountMinor: 110, currency: "PLN" },
    },
  };
}

describe("createExpectedQuote", () => {
  it("returns the parsed quote on a valid response", async () => {
    const expected = await createExpectedQuote(portReturning(validResponse()), REQUEST, MESSAGES);
    expect(expected.quote.lines[0].sku).toBe("OPENLUP-DOG-LAMB-CAN-400G");
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
      new CommerceQuoteError("UNKNOWN_SKU", "nope", { sku: "OPENLUP-DOG-DUCK-CAN-400G" }),
    );
    await expect(createExpectedQuote(port, REQUEST, MESSAGES)).rejects.toMatchObject({
      name: "CommerceQuoteSnapshotError",
      message: "MISMATCH_MSG",
      details: { reason: "UNKNOWN_SKU", sku: "OPENLUP-DOG-DUCK-CAN-400G" },
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
