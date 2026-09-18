import { z } from "../../lib/validation/zod.js";

import { SUPPORT_CUSTOMER_360_CONTRACT_VERSION, idSchema } from "./customer360Contracts.js";

/**
 * The escape hatch for the one refusal an operator cannot otherwise get past.
 *
 * `correct_email` refuses with `email_already_in_use` when another record already
 * holds the address, and until now that was the end of the road: the paying
 * customer stayed on her mistyped address and never received her parcel. In
 * practice the record in the way is a marketing lead - a shell carrying
 * personalization, consents and attribution and nothing commercial - and every
 * comparable system ships a way to fold that shell into the real customer.
 *
 * `absorb_lead` is that way, and it is deliberately *not* a general merge. Two
 * records that both carry commercial history are routed to a human by name; this
 * command refuses them and says which tables blocked it. The refusal is the
 * feature: it is what makes the success arm safe to offer from a console button.
 *
 * These schemas live beside, not inside, ./customerSupportCommandContracts.ts,
 * which was one line under its size cap. The two correction primitives every
 * command shares - the address bound and the idempotency-key bound - moved here
 * with them and are imported back, so there is still exactly one definition of
 * each and the dependency runs in one direction only.
 */

/**
 * E-mail as an operator may type it, lower-cased on the way in so an expectation
 * check never fails on capitalisation alone.
 */
export const operatorEmailSchema = z.string().trim().toLowerCase().email().max(320);
export const idempotencyKeySchema = z.string().trim().min(8).max(200);

/**
 * Why absorption was refused, in the authority's own vocabulary.
 *
 * The first three are shape and expectation faults - the operator aimed at
 * something that is not there, or the address moved under them since the console
 * read it. The last three are substance: an identity is never absorbed silently
 * (that is the account-takeover guard), a commercial footprint is never absorbed
 * at all, and a referencing table nobody has classified refuses until somebody
 * does. That last one is the one that keeps this safe as the schema grows: a
 * table added next month cannot be silently dropped or silently carried.
 */
export const operatorLeadAbsorptionRefusalCodeSchema = z.enum([
  "lead_not_found",
  "customer_not_found",
  "lead_email_expectation_conflict",
  "lead_has_identity",
  "lead_has_commercial_footprint",
  "unclassified_referencing_table",
]);

/**
 * `expectedLeadEmail` is the optimistic check, and it is required rather than
 * optional: the console only ever reaches this command holding the address it
 * just failed to take, so an absorption that cannot name the address it believes
 * it is freeing is an absorption aimed at the wrong record.
 */
export const operatorLeadAbsorptionRequestSchema = z.object({
  action: z.literal("absorb_lead"),
  subjectId: idSchema,
  leadId: idSchema,
  expectedLeadEmail: operatorEmailSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

const countSchema = z.number().int().min(0);

/**
 * What moved onto the customer, counted per kind.
 *
 * Counts rather than rows: the console has to be able to tell an operator that
 * the campaign attribution and the consent record survived, and a count says that
 * without carrying a second copy of a customer's marketing profile across the
 * wire. Every key is present and explicitly zero, so "carried nothing" and
 * "this lane does not report it" can never be confused.
 */
export const leadAbsorptionCarriedSchema = z.object({
  personalization: countSchema,
  consents: countSchema,
  sourceLinks: countSchema,
  deliveries: countSchema,
}).strict();

const absorptionResponseBaseSchema = z.object({
  contractVersion: z.literal(SUPPORT_CUSTOMER_360_CONTRACT_VERSION),
  action: z.literal("absorb_lead"),
  subjectId: idSchema,
  leadId: idSchema,
});

const blockingTablesSchema = z.array(z.string().trim().min(1).max(120)).max(200);

const absorptionSettled = (outcome: "applied" | "noop" | "replayed") =>
  absorptionResponseBaseSchema.extend({
    outcome: z.literal(outcome),
    carried: leadAbsorptionCarriedSchema,
  }).strict();

/**
 * `blockingTables` is always present and empty for the four refusals that have
 * nothing to list, because the card renders the list and an absent key would make
 * it render "unknown" for a refusal that is perfectly well explained.
 *
 * `conflict` is a modelled 200 arm, not an HTTP status. It used to become a 409
 * with its `refusalCode` discarded, which cost the console the reason twice over;
 * the route stopped doing that and this union is why it can.
 */
const absorptionRefused = (outcome: "refused" | "conflict") =>
  absorptionResponseBaseSchema.extend({
    outcome: z.literal(outcome),
    refusalCode: operatorLeadAbsorptionRefusalCodeSchema,
    blockingTables: blockingTablesSchema,
  }).strict();

export const operatorLeadAbsorptionResponseSchema = z.discriminatedUnion("outcome", [
  absorptionSettled("applied"), absorptionSettled("noop"), absorptionSettled("replayed"),
  absorptionRefused("refused"), absorptionRefused("conflict"),
]);

export type OperatorLeadAbsorptionRefusalCode = z.infer<typeof operatorLeadAbsorptionRefusalCodeSchema>;
export type OperatorLeadAbsorptionRequest = z.infer<typeof operatorLeadAbsorptionRequestSchema>;
export type LeadAbsorptionCarried = z.infer<typeof leadAbsorptionCarriedSchema>;
export type OperatorLeadAbsorptionResponse = z.infer<typeof operatorLeadAbsorptionResponseSchema>;
