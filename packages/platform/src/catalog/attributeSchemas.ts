import { z } from "./validation.js";
import { catalogNamespacedKeySchema } from "./productTypeIssues.js";

export const catalogAttributeReferenceSchema = z.object({
  namespace: catalogNamespacedKeySchema, id: z.string().min(1).max(120),
}).strict();
const signedDecimal = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
/** Exact signed decimal decomposition; never converts a value through Number. */
export function catalogAttributeDecimal(value: unknown): { coefficient: bigint; scale: number } | undefined {
  if (typeof value !== "string" || value.length > 66 || !signedDecimal.test(value)) return undefined;
  const [integer, fraction = ""] = value.split(".");
  return { coefficient: BigInt(`${integer}${fraction}`), scale: fraction.length };
}
export function compareAttributeDecimals(left: { coefficient: bigint; scale: number }, right: { coefficient: bigint; scale: number }): bigint {
  return left.coefficient * 10n ** BigInt(right.scale) - right.coefficient * 10n ** BigInt(left.scale);
}
/** A calendar date, not a timestamp or a date that the runtime silently rolls over. */
export const catalogAttributeDateSchema = z.iso.date().refine((value) => !value.startsWith("0000-"));
