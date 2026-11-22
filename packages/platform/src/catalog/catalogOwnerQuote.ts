import { createHash } from "node:crypto";
import type { CatalogAdmissionEvidence } from "@openlup/core/catalog";
import type { CatalogAdmissionInput } from "./contracts/admission.js";
import { catalogAdmissionEvidenceSchema } from "./catalogAdmissionSchema.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import { projectPublicQuoteSnapshot, quoteDigest, type CreateQuoteResponse } from "../pricing/index.js";

const dependencyRoles = ["actual", "base", "comparison", "offer"] as const;
type PriceSelector = {
  sourceOrdinal: number;
  role: typeof dependencyRoles[number];
  selectorKey: string;
  evidence: unknown;
};

const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const evidenceRef = (dialect: "price.v1" | "policy.v1", value: unknown) =>
  `${dialect}:${createHash("sha256").update(canonicalCatalogDraftJson([dialect, value]), "utf8").digest("hex")}`;

// Exclude the private fact copies already lifted to selector and line evidence.
// Preserve public values, including times the buyer actually reviewed.
function omitPrivateFacts(key: string, value: unknown): unknown {
  if (key === "quoteLine" && value !== null && typeof value === "object" && "catalogFacts" in value) {
    const { catalogFacts: _facts, ...line } = value;
    return line;
  }
  return value;
}

export function ownerQuoteProjection(snapshot: CreateQuoteResponse): unknown {
  return JSON.parse(JSON.stringify(projectPublicQuoteSnapshot(snapshot), omitPrivateFacts));
}

export function buildCatalogOwnerQuote(input: {
  quote: CreateQuoteResponse;
  consultedHeads: CatalogAdmissionEvidence["consultedHeads"];
  offer?: CatalogAdmissionEvidence["offer"];
  lineBindings: CatalogAdmissionEvidence["lineBindings"];
  priceSelectors: PriceSelector[];
  policy: { applicability: "not_applicable"; context: unknown } |
    { applicability: "applies"; context: unknown; revisionRef: string; revisionDigest: string };
}): { document: CatalogAdmissionInput["ownerDocument"]; evidence: CatalogAdmissionEvidence } {
  const selectors = [...input.priceSelectors].sort((a, b) => a.sourceOrdinal - b.sourceOrdinal
    || dependencyRoles.indexOf(a.role) - dependencyRoles.indexOf(b.role) || order(a.selectorKey, b.selectorKey));
  const coordinates = new Set(selectors.map(value => JSON.stringify([value.sourceOrdinal, value.role, value.selectorKey])));
  if (selectors.length < input.lineBindings.length || selectors.length > 500 || coordinates.size !== selectors.length
    || selectors.some(value => !Number.isInteger(value.sourceOrdinal) || value.sourceOrdinal < 1
      || value.sourceOrdinal > input.lineBindings.length || !dependencyRoles.includes(value.role)
      || !value.selectorKey || new TextEncoder().encode(value.selectorKey).length > 240)
    || input.lineBindings.length !== input.quote.quote.lines.length
    || input.lineBindings.some((value, index) => value.skuCode !== input.quote.quote.lines[index]?.sku
      || value.quantity !== input.quote.quote.lines[index]?.quantity)) {
    throw new Error("catalog_admission_evidence_binding_mismatch");
  }
  const document = {
    reviewedProjection: ownerQuoteProjection(input.quote),
    consultedHeads: [...input.consultedHeads].sort((a, b) => order(a.productId, b.productId)),
    ...(input.offer === undefined ? {} : { offer: input.offer }),
    lineBindings: input.lineBindings,
    priceEvidenceRef: evidenceRef("price.v1", selectors),
    policyEvidenceRef: evidenceRef("policy.v1", input.policy),
  };
  const { reviewedProjection: _projection, ...retained } = document;
  const evidence = catalogAdmissionEvidenceSchema.parse({
    ...retained, moneyVersion: "v0", quoteDigest: quoteDigest("catalog.owner-quote.v0", document),
  });
  return { document, evidence };
}
