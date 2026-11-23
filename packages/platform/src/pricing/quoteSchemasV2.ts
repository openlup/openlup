import { z } from "zod";
import { canonicalCatalogDraftJson, CATALOG_DRAFT_MAX_BYTES } from "../catalog/contracts/index.js";
import type { CommerceQuoteV2 } from "./contracts/quoteV2.js";
import { quoteDigest } from "./quoteDigest.js";
import { checkDocumentSize, checkMoney, inputData, inputField, MoneyIssue, quoteShape, shapePath } from "./quoteMoneyValidationV2.js";

function integrityIssue(document: CommerceQuoteV2): MoneyIssue | undefined {
  checkDocumentSize(document);
  const { quoteDigest: outer, ...quote } = JSON.parse(canonicalCatalogDraftJson(document)) as CommerceQuoteV2;
  const { moneyDigest: inner, quoteId: _id, status: _status, schemaVersion: _schema, contractVersion: _contract, ...money } = quote;
  const remedy = "Replay the original document and its digest.";
  if (quoteDigest("commerce.quote-money.v2", money) !== inner) return new MoneyIssue("money_tax_evidence_mismatch", ["moneyDigest"], remedy);
  if (quoteDigest("commerce.quote.v2", quote) !== outer) return new MoneyIssue("money_tax_evidence_mismatch", ["quoteDigest"], remedy);
}

/** @experimental Validate both digest bindings before checking money. Read code, field and remedy from the issue params. */
export const commerceQuoteV2Schema: z.ZodType<CommerceQuoteV2> = z.unknown().transform((value, ctx) => {
  try {
    const input = inputData(value, "amountBasis", CATALOG_DRAFT_MAX_BYTES);
    const parsed = quoteShape.safeParse(input, { reportInput: true });
    if (!parsed.success && (parsed.error.issues[0].input === undefined
      || ["amountBasis", "moneyDigest", "quoteDigest"].some(key => !Object.hasOwn(input as object, key)))) {
      throw new MoneyIssue("money_input_invalid", shapePath(parsed.error.issues[0]));
    }
    const issue = integrityIssue(input as CommerceQuoteV2) ?? (parsed.success ? checkMoney(parsed.data)
      : new MoneyIssue("money_input_invalid", shapePath(parsed.error.issues[0])));
    if (issue) throw issue;
    return parsed.success ? parsed.data : z.NEVER;
  } catch (error) {
    const { path, code, remedy } = error instanceof MoneyIssue ? error : new MoneyIssue("money_input_invalid", ["quoteDigest"]);
    ctx.addIssue({ code: "custom", path, message: remedy, params: { code, field: inputField(value, path, "amountBasis"), remedy } });
    return z.NEVER;
  }
});
