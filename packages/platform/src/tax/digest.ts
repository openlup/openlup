import { createHash } from "node:crypto";
import { canonicalCatalogDraftJson } from "../catalog/contracts/index.js";
import { bounded, invalid } from "./contracts/decode.js";
import { compareCells, compareDeclarations } from "./contracts/identity.js";
import { parseQuoteKey, quoteInputSchema } from "./contracts/schemas.js";
import type { TaxQuoteInputV1, TaxQuoteRequestV1 } from "./contracts/index.js";

type DigestTag = "input" | "coverage" | "fiscal" | "resolution" | "evidence" | "rate-table" | "close" | "commit" | "reverse";

export function taxDigest(tag: DigestTag, payload: unknown): string {
  try {
    const canonical = canonicalCatalogDraftJson(["platform.tax." + tag + ".v1", payload]);
    return createHash("sha256").update(canonical, "utf8").digest("hex");
  } catch {
    return invalid("", "Supply a canonical document of at most one MiB including its digest tag.");
  }
}

export function makeTaxQuoteRequest(key: string, input: TaxQuoteInputV1): TaxQuoteRequestV1 {
  const parsedKey = parseQuoteKey(key);
  const parsed = quoteInputSchema.parse(input);
  const normalized = {
    ...parsed,
    required: [...parsed.required].sort(compareCells),
    coverage: { ...parsed.coverage, declarations: [...parsed.coverage.declarations].sort(compareDeclarations) },
  };
  return bounded({ key: parsedKey, input: normalized, inputDigest: taxDigest("input", normalized) });
}
