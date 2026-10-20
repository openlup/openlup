import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCommerceQuoteHandler } from "../../src/pricing/index.js";
import { createPromotionQuoteAcceptance } from "../../src/promotions/index.js";
import { terms, quote, request, responder, response, schemas, AT } from "../pricing/acquisitionFixtures.js";

describe("resolved acquisition acceptance callbacks", () => {
  it("passes the server terms to issue and honor and binds a changed promise", async () => {
    const acceptance = createPromotionQuoteAcceptance<typeof request>({ projectRequest: value => value });
    const keyring = { current: "synthetic-acceptance-key-000000000000000000" }, now = new Date(AT);
    const currentQuote = { ...quote, acquisitionTerms: terms };
    const extended = schemas.createQuoteResponseSchema.safeExtend({ quote: schemas.createQuoteResponseSchema.shape.quote.safeExtend({ acquisitionTerms: z.unknown().optional() }) });
    const issued = vi.fn((value, money, acquisitionTerms) => acceptance.issuePromotionQuoteAcceptance({ request: value, quote: money, acquisitionTerms, keyring, now }));
    const honored = vi.fn((token, value, money, acquisitionTerms) => acceptance.verifyPromotionQuoteAcceptance({ token, request: value, quote: money, acquisitionTerms, expectedTotal: money.totalGross, keyring, now }));
    const deps = { responder, createQuoteRequestSchema: schemas.createQuoteRequestSchema, createQuoteResponseSchema: extended,
      publicCreateQuoteRequestSchema: schemas.publicCreateQuoteRequestSchema, publicCreateQuoteResponseSchema: extended.safeExtend({ promotionAcceptanceToken: z.string().optional() }),
      acquisition: { terms: () => terms }, quotePort: { createQuote: async () => ({ contractVersion: "commerce.v0" as const, quote: currentQuote }) },
      createPromotionAcceptance: issued, honorPromotionAcceptance: honored };
    const first = response();
    await createCommerceQuoteHandler(deps)({ method: "POST", body: request }, first.res);
    expect(first.transcript.status).toBe(200);
    const token = (first.transcript.body as { data: { promotionAcceptanceToken: string } }).data.promotionAcceptanceToken;
    expect(issued.mock.calls[0]![2]).toBe(terms);
    const second = response();
    await createCommerceQuoteHandler(deps)({ method: "POST", body: { ...request, promotionAcceptanceToken: token } }, second.res);
    expect(second.transcript.status).toBe(200);
    expect(honored.mock.calls[0]![2]).toEqual(currentQuote);
    expect(honored.mock.calls[0]![3]).toBe(terms);
    expect(honored.mock.results[0]!.value).toBe(true);
    expect(issued).toHaveBeenCalledOnce();
    const changed = response();
    await createCommerceQuoteHandler({ ...deps, acquisition: { terms: () => ({ ...terms, delivery2DiscountBps: 1800 }) } })({ method: "POST", body: { ...request, promotionAcceptanceToken: token } }, changed.res);
    expect(honored.mock.results[1]!.value).toBe(false);
    expect(issued).toHaveBeenCalledTimes(2);
    expect(issued.mock.calls[1]![2]).toEqual({ ...terms, delivery2DiscountBps: 1800 });
    const inactive = response();
    await createCommerceQuoteHandler({ ...deps, acquisition: undefined })({ method: "POST", body: request }, inactive.res);
    expect(issued.mock.calls[2]![2]).toBeUndefined();
    expect(inactive.transcript.status).toBe(200);
  });
});
