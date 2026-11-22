import { z } from "zod";
import { MAX_CADENCE_DAYS } from "./types.js";

/** Versioned cadence metadata. Calendar months are reserved for a future scheduler.
 * @experimental
 */
export type CadenceChoiceV1 =
  | { readonly schemaVersion: 1; readonly kind: "fixed_days"; readonly days: number }
  | { readonly schemaVersion: 1; readonly kind: "calendar_months"; readonly months: number };

/** Parses the wire choice, including the reserved discriminator.
 * @experimental
 */
export function parseCadenceChoiceV1(input: unknown): CadenceChoiceV1 | null {
  return cadenceChoiceV1Schema.safeParse(input).data ?? null;
}

export const fixedCadenceDaysSchema = z.number().int().min(1).max(MAX_CADENCE_DAYS);
export const cadenceChoiceV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ schemaVersion: z.literal(1), kind: z.literal("fixed_days"), days: fixedCadenceDaysSchema }),
  z.strictObject({ schemaVersion: z.literal(1), kind: z.literal("calendar_months"), months: z.number().int().positive() }),
]);
