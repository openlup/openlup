import { z } from "./validation.js";
import { CATALOG_PRICE_SETUP_MAX_MINOR, canonicalCatalogPriceSetupCommandV2 } from "../pricing/index.js";
import type { CatalogDraftBasisPriceOperationV2 } from "./contracts/draftV2.js";

const reference = z.string().refine(value => value.length >= 1 && value.length <= 240 && value.trim() === value);
const tax = z.object({ market: reference, taxClassKey: reference, classMapRevision: reference,
  classMapDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const contextSchema = z.object({
  priceListId: z.guid().refine(value => value === value.toLowerCase()),
  regionCode: z.string().regex(/^[A-Z]{2}$/u), currency: z.string().regex(/^[A-Z]{3}$/u),
  amountBasis: z.enum(["tax_inclusive", "tax_exclusive"]), tax: tax.nullable(),
}).strict().refine(context => (context.amountBasis === "tax_exclusive") === (context.tax !== null), { path: ["tax"] });
export type DraftBasisPriceContext = z.infer<typeof contextSchema>;

const header = z.object({ schemaVersion: z.literal(2), unitPriceMinor: z.unknown().optional(), expected: z.unknown().optional() });
const genericFix = "Popraw wskazane pole, zapisz nową rewizję i uruchom Prepare dla tej rewizji.";
const refuses = (code: string, path: string, fix = genericFix, observed?: string) =>
  ({ code, path, message: observed === undefined ? fix : `${observed}. ${fix}` });
const contextPath = "publication.evidence.priceContext";

export function readDraftBasisPrices(skus: readonly { id: string; priceOperations?: unknown[] | undefined }[], evidence: unknown) {
  const rawContext = z.object({ priceContext: z.unknown().optional() }).safeParse(evidence).data?.priceContext;
  const operations = skus.flatMap((sku, i) => (sku.priceOperations ?? []).map((operation, j) =>
    ({ operation, skuId: sku.id, path: `skus.${i}.priceOperations.${j}` })));
  const basis = operations.flatMap(row => {
    const fields = header.safeParse(row.operation);
    return fields.success ? [{ ...row, fields: fields.data }] : [];
  });
  if (!basis.length && rawContext === undefined) return {};
  const context = contextSchema.safeParse(rawContext);
  for (const { fields, operation, path, skuId } of basis) {
    const previous = z.object({ unitPriceMinor: z.unknown().optional() }).safeParse(fields.expected).data?.unitPriceMinor;
    for (const [field, value, min] of [["unitPriceMinor", fields.unitPriceMinor, 1],
      ["expected.unitPriceMinor", previous, 0]] as const) {
      if (typeof value === "number" && (!Number.isInteger(value) || value < min || value > CATALOG_PRICE_SETUP_MAX_MINOR))
        return { issue: refuses("money_amount_out_of_range", `${path}.${field}`,
          "Wpisz w oznaczonym polu całkowitą kwotę w jednostkach minor z podanego zakresu, zapisz nową rewizję i uruchom Prepare.",
          `${min}–${CATALOG_PRICE_SETUP_MAX_MINOR}`) };
    }
    try { canonicalCatalogPriceSetupCommandV2(operation); }
    catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      const issue = error.issues[0]!;
      const field = issue.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]].join(".") : issue.path.join(".");
      return { issue: refuses("price_operation_invalid", field ? `${path}.${field}` : path) };
    }
    const price = operation as CatalogDraftBasisPriceOperationV2;
    if (price.variantId !== skuId) return { issue: refuses("price_operation_invalid", `${path}.variantId`) };
    if (context.success && price.priceListId !== context.data.priceListId) return { issue: refuses("command_invalid", `${path}.priceListId`) };
    if (context.success && price.expectedListAmountBasis !== context.data.amountBasis) return { issue: refuses("command_invalid", `${path}.expectedListAmountBasis`) };
  }
  if (!basis.length || !context.success) {
    const field = context.error?.issues[0]?.path.join(".");
    return { issue: refuses("command_invalid", field ? `${contextPath}.${field}` : contextPath) };
  }
  const keys = new Set<string>();
  for (const { operation, path } of operations) {
    const key = z.object({ commandKey: z.string() }).safeParse(operation).data?.commandKey;
    if (key === undefined) continue;
    if (keys.has(key)) return { issue: refuses("catalog_publication_price_key_reused", `${path}.commandKey`,
      "Nadaj zmienionej operacji nieużywany klucz, zapisz nową rewizję i uruchom Prepare.") };
    keys.add(key);
  }
  return { context: context.data, v2: new Set(basis.map(row => row.operation)) };
}
