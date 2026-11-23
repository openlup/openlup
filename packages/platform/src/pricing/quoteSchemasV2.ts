import { z } from "zod";
import { CATALOG_DRAFT_MAX_BYTES } from "../catalog/contracts/index.js";
import type { CommerceQuoteV2 } from "./contracts/quoteV2.js";
import { quoteDigest } from "./quoteDigest.js";
import { admit, checkMoney, digest, MoneyIssue, pointer, quoteShape, shapePath } from "./quoteMoneyValidationV2.js";

function checkIntegrity(document: CommerceQuoteV2): void {
  const { quoteDigest: outer, ...quote } = document;
  const { moneyDigest: inner, quoteId: _id, status: _status, schemaVersion: _schema, contractVersion: _contract, ...money } = quote;
  if (!digest.safeParse(inner).success || !digest.safeParse(outer).success) return;
  const remedy = "Replay the original document and its digest.";
  if (quoteDigest("commerce.quote-money.v2", money) !== inner) throw new MoneyIssue("money_tax_evidence_mismatch", ["moneyDigest"], remedy);
  if (quoteDigest("commerce.quote.v2", quote) !== outer) throw new MoneyIssue("money_tax_evidence_mismatch", ["quoteDigest"], remedy);
}

/** @experimental Validate plain JSON quotes, refusing hidden own keys. Read code, field and remedy from issue params. */
export const commerceQuoteV2Schema: z.ZodType<CommerceQuoteV2> = z.unknown().transform((value, ctx) => {
  try {
    const input = admit(value, CATALOG_DRAFT_MAX_BYTES);
    checkIntegrity(input as CommerceQuoteV2);
    const parsed = quoteShape.safeParse(input);
    if (!parsed.success) throw new MoneyIssue("money_input_invalid", shapePath(parsed.error.issues[0]));
    const issue = checkMoney(parsed.data);
    if (issue) throw issue;
    return parsed.data;
  } catch (error) {
    const { path, code, remedy } = error instanceof MoneyIssue ? error : new MoneyIssue("money_input_invalid", ["quoteDigest"]);
    ctx.addIssue({ code: "custom", path, message: remedy, params: { code, field: pointer(path), remedy } });
    return z.NEVER;
  }
});
