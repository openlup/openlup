import { z } from "zod";
// OMS read money permits signed adjustments and rejects unknown fields.
export const commerceMoneySchema = z.object({ amountMinor: z.number().int(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
