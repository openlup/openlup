import { z } from "../../lib/validation/zod.js";

import { idSchema } from "./customer360Contracts.js";

/**
 * The address half of the operator subscription command.
 *
 * It lives beside `./customerSupportCommandContracts.ts` rather than inside it
 * for one reason worth stating: the two ways an operator can name a destination
 * are mutually exclusive, and the exclusion is expressed by construction here -
 * two closed object shapes, neither of which admits the other's key - rather
 * than by a cross-field rule a reader has to find. The authority makes the same
 * refusal (a malformed command, not a business refusal) for the same reason.
 *
 * Support takes new addresses over the phone, so `newAddress` is not an
 * optional convenience: without it the picker can only offer what the
 * subscriber already saved, which is the case that is not the one she is
 * calling about.
 */

/**
 * `reason` rides on both shapes because it is the operator's own note about the
 * call, not part of either destination, and the authority forwards it into the
 * event ledger unchanged for either one.
 */
const operatorAddressReasonSchema = z.string().trim().min(1).max(500).optional();

/**
 * The field bounds are the ones `addresses` itself enforces, so a value that
 * passes here cannot abort the INSERT the authority performs. `country` is
 * accepted in either case and stored upper-cased by the authority, matching how
 * every other writer of that column behaves.
 */
export const operatorNewShippingAddressSchema = z.object({
  recipientName: z.string().trim().min(1).max(200),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().min(1).max(200).optional(),
  postalCode: z.string().trim().min(1).max(32),
  city: z.string().trim().min(1).max(200),
  country: z.string().trim().min(2).max(3),
  contactPhone: z.string().trim().min(1).max(64).optional(),
}).strict();

/** Pick an address the subscriber already saved. */
export const operatorSavedShippingAddressPayloadSchema = z.object({
  shippingAddressId: idSchema,
  reason: operatorAddressReasonSchema,
}).strict();

/** Write down a new one during the call. */
export const operatorCreatedShippingAddressPayloadSchema = z.object({
  newAddress: operatorNewShippingAddressSchema,
  reason: operatorAddressReasonSchema,
}).strict();

/**
 * Exactly one of the two, enforced by the shapes themselves: each is closed, so
 * a payload carrying both keys matches neither.
 */
export const operatorChangeShippingAddressPayloadSchema = z.union([
  operatorSavedShippingAddressPayloadSchema,
  operatorCreatedShippingAddressPayloadSchema,
]);

export type OperatorNewShippingAddress = z.infer<typeof operatorNewShippingAddressSchema>;
export type OperatorChangeShippingAddressPayload = z.infer<typeof operatorChangeShippingAddressPayloadSchema>;
