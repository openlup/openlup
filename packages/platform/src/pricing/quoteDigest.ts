import { createHash } from "node:crypto";
import { canonicalCatalogDraftJson } from "../catalog/contracts/index.js";

/** Hash the canonical, domain-tagged owner quote document.
 * @experimental
 */
export function quoteDigest(dialect: "catalog.owner-quote.v0", document: unknown): string {
  if (dialect !== "catalog.owner-quote.v0") throw new Error("quote_digest_dialect_unsupported");
  return createHash("sha256").update(canonicalCatalogDraftJson([dialect, document]), "utf8").digest("hex");
}
