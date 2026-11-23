import { z } from "zod";
import { CATALOG_DRAFT_MAX_BYTES } from "../catalog/contracts/index.js";
import type { CommerceQuoteV2 } from "./contracts/quoteV2.js";
import { quoteDigest } from "./quoteDigest.js";
import { checkMoney, invalid, pointer, quoteShape } from "./quoteMoneyValidationV2.js";
import type { MoneyIssue } from "./quoteMoneyValidationV2.js";

// Only inspect descriptors before passing the raw document to the canonical encoder.
function isDataTree(value: unknown, depth = 0, size = { remaining: CATALOG_DRAFT_MAX_BYTES }): boolean {
  size.remaining -= typeof value === "string" ? Math.max(value.length, 1) : 1;
  if (depth > 48 || size.remaining < 0) return false;
  if (typeof value !== "object" || value === null) return true;
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every(key => {
    if (Array.isArray(value) && key === "length") return true;
    const item = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === "string" && !!item?.enumerable && "value" in item && isDataTree(item.value, depth + 1, size);
  });
}

function integrityIssue(value: unknown): MoneyIssue | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid([]);
  try {
    if (!isDataTree(value)) return invalid([]);
    const { quoteDigest: outer, ...quote } = value as CommerceQuoteV2;
    const { moneyDigest: inner, quoteId: _id, status: _status, schemaVersion: _schema, contractVersion: _contract, ...money } = quote;
    const remedy = "Replay the original document and its digest.";
    if (quoteDigest("commerce.quote-money.v2", money) !== inner) {
      return { path: ["moneyDigest"], code: "money_tax_evidence_mismatch", remedy };
    }
    if (quoteDigest("commerce.quote.v2", quote) !== outer) return { path: ["quoteDigest"], code: "money_tax_evidence_mismatch", remedy };
  } catch {
    return invalid([]);
  }
}

/** @experimental Validate the original digest bindings before checking quote money. */
export const commerceQuoteV2Schema: z.ZodType<CommerceQuoteV2> = z.unknown().transform((value, ctx) => {
  function reject({ path, code, remedy }: MoneyIssue): never {
    ctx.addIssue({ code: "custom", path, message: remedy, params: { code, field: pointer(path), remedy } });
    return z.NEVER;
  }
  const integrity = integrityIssue(value);
  if (integrity) return reject(integrity);
  const parsed = quoteShape.safeParse(value);
  if (!parsed.success) return reject(invalid(parsed.error.issues[0].path.map(key => typeof key === "symbol" ? String(key) : key)));
  const issue = checkMoney(parsed.data);
  return issue ? reject(issue) : parsed.data;
});
