import { z } from "zod";
import type { CommerceQuoteV2 } from "./contracts/quoteV2.js";
import { quoteDigest } from "./quoteDigest.js";
import { admit, checkMoney, digest, MoneyIssue, pointer, quoteShape, shapePath } from "./quoteMoneyValidationV2.js";

function checkIntegrity(document: CommerceQuoteV2): void {
  const { quoteDigest: outer, ...quote } = document;
  const { moneyDigest: inner, quoteId: _id, status: _status, schemaVersion: _schema, contractVersion: _contract, ...money } = quote;
  const moneyMismatch = inner === undefined ? outer !== undefined
    : digest.safeParse(inner).success && quoteDigest("commerce.quote-money.v2", money) !== inner;
  const quoteMismatch = outer === undefined ? inner !== undefined
    : digest.safeParse(outer).success && quoteDigest("commerce.quote.v2", quote) !== outer;
  if (moneyMismatch || quoteMismatch) throw new MoneyIssue("money_tax_evidence_mismatch",
    [moneyMismatch && outer !== undefined ? "moneyDigest" : "quoteDigest"], "Replay the original document and its digest.");
}

/** @experimental Validate plain JSON quotes, refusing hidden own keys. Read code, field and remedy from issue params. */
export const commerceQuoteV2Schema: z.ZodType<CommerceQuoteV2> = z.unknown().transform((value, ctx) => {
  try {
    const input = admit(value);
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
