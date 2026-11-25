import { createHash } from "node:crypto";
import { canonicalCatalogDraftJson } from "../catalog/contracts/index.js";
import type { CommerceQuoteMoneyV2, CommerceQuoteV2 } from "./contracts/quoteV2.js";
/** Hash the canonical, domain-tagged owner quote document.
 * @experimental
 */
export function quoteDigest(dialect: "catalog.owner-quote.v0", document: unknown): string;
/** @experimental Hash an estimate or final quote excluding its own digest. */
export function quoteDigest(dialect: "commerce.quote.v2", document: Omit<CommerceQuoteV2, "quoteDigest">): string;
/** @experimental Hash the shared money before composing the full quote. */
export function quoteDigest(dialect: "commerce.quote-money.v2", document: CommerceQuoteMoneyV2): string;
/** @experimental Hash a final quote's digest, sorted fee keys and all-in payable. */
export function quoteDigest(dialect: "commerce.quote-presentation.v2",
  document: readonly [string, readonly string[], Readonly<{ currency: string; amountMinor: number }>]): string;
export function quoteDigest(dialect: string, document: unknown): string {
  if (dialect !== "catalog.owner-quote.v0" && dialect !== "commerce.quote.v2" && dialect !== "commerce.quote-money.v2"
    && dialect !== "commerce.quote-presentation.v2") {
    throw new Error("quote_digest_dialect_unsupported");
  }
  return createHash("sha256").update(canonicalCatalogDraftJson([dialect, document]), "utf8").digest("hex");
}
