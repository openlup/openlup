import { z } from "../../lib/validation/zod.js";

import artifact from "../../../config/blik-recurring-banks.json" with { type: "json" };

const bankSchema = z
  .object({
    id: z.string().trim().min(1),
    displayName: z.string().trim().min(1),
    /**
     * True only where a real model-O mandate has been observed end to end.
     * Everything else is inferred from BLIK's general recurring roster, which is
     * never published per model.
     */
    modelOVerified: z.boolean(),
  })
  .strict();

const artifactSchema = z
  .object({
    lastReviewedAt: z.string().trim().min(1),
    banks: z.array(bankSchema).min(1),
  })
  .loose();

export type BlikRecurringBank = z.infer<typeof bankSchema>;

const parsed = artifactSchema.parse(artifact);

/**
 * Banks offered in the checkout picker before the buyer types a BLIK code.
 *
 * This is a **UX filter, not a guard**. The buyer self-declares, so the answer
 * can simply be wrong — picking one bank and then generating the code in another
 * app is an ordinary mistake for anyone holding two accounts. The authoritative
 * check is `refuseNoPayId`, which has BLIK reject an incapable bank in well under
 * a second and takes no money when it does. Filtering here only spares most
 * buyers from meeting that rejection at all.
 *
 * See `config/blik-recurring-banks.json` for provenance and the model-A/M/O
 * caveat.
 */
export const BLIK_RECURRING_BANKS: readonly BlikRecurringBank[] = Object.freeze(parsed.banks);

/** Date the roster was last checked against blik.com. BLIK publishes no feed. */
export const BLIK_RECURRING_BANKS_REVIEWED_AT = parsed.lastReviewedAt;

export function isBlikRecurringBankId(value: string): boolean {
  return BLIK_RECURRING_BANKS.some((bank) => bank.id === value);
}

export function blikRecurringBankById(value: string): BlikRecurringBank | null {
  return BLIK_RECURRING_BANKS.find((bank) => bank.id === value) ?? null;
}
