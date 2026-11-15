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

/** Upper bound for UTF-8 jsonb::text, after the canonical JSON safety guard.
 * PostgreSQL adds one space after each colon/comma; string escaping matches JSON.
 * Scientific numeric tokens may expand: adding the exponent magnitude bounds
 * that expansion conservatively. Admitted values only contain integer quantity
 * scales 0–12 as JSON numbers, so their count is exact. Key order changes no bytes.
 */
export function catalogAttributeStorageBytes(value: unknown): number {
  function extraBytes(item: unknown): number {
    if (Array.isArray(item)) return Math.max(0, item.length - 1) + item.reduce((sum, child) => sum + extraBytes(child), 0);
    if (item !== null && typeof item === "object") {
      const children = Object.values(item);
      return children.length + Math.max(0, children.length - 1) + children.reduce<number>((sum, child) => sum + extraBytes(child), 0);
    }
    if (typeof item === "number") {
      const exponent = JSON.stringify(item).split("e")[1];
      return exponent === undefined ? 0 : Math.abs(parseInt(exponent, 10));
    }
    return 0;
  }
  return new TextEncoder().encode(JSON.stringify(value)).byteLength + extraBytes(value);
}
