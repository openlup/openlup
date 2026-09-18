import { z } from "../../lib/validation/zod.js";
import { starterOfferResponseSchema } from "./starterOfferContracts.js";
import { STARTER_OFFER_CAPABILITY } from "./starterOfferPolicy.js";

/**
 * Early customer-recognition + first-order-eligibility lookup.
 *
 * Called from the "Twoje dane" configurator step (before pricing) so the UI can:
 *  - greet a returning buyer and invite login;
 *  - know whether the first-order discount actually applies, so the price shown
 *    on the package step already matches eligibility (no last-step "jump").
 *
 * The response carries NO PII and NO client id — only two booleans — so it
 * cannot be used to scrape customer details. The paid-customer signal is an
 * intentional product requirement and is protected by server-side rate limiting.
 *
 * `recognized` requires an EXACT-email match with paid-order history. A guest
 * typing a `+tag` alias is reported as NOT recognized. Plus-alias folding is
 * retained only for `firstOrderEligible` (anti-farming).
 */

export const CUSTOMER_ELIGIBILITY_CONTRACT_VERSION = "customer_eligibility.lookup.v1" as const;

export const customerEligibilityLookupRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    /** Persistent first-party device id — advisory device first-order signal. */
    visitorId: z.string().trim().min(1).max(120).optional(),
    /**
     * Capability handshake. A client that understands the starter-pack offer
     * declares it here; the server then MAY answer with `starterOffer`. Absent
     * capability means the response is byte-identical to the pre-capability
     * contract, so an older client keeps working with no version bump.
     */
    offerModeCapability: z.literal(STARTER_OFFER_CAPABILITY).optional(),
  })
  .strict();

export const customerEligibilityLookupResponseSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_ELIGIBILITY_CONTRACT_VERSION),
    /** True when an exact-email customer has at least one paid order. */
    recognized: z.boolean(),
    /** True when this email is eligible for the first-order discount. */
    firstOrderEligible: z.boolean(),
    /**
     * Advisory starter-pack offer terms. Emitted ONLY when the request carried
     * `offerModeCapability` and the server-side flag is on. Optional and
     * additive, so a response minted before this field existed still parses
     * against the `.strict()` schema while an unknown key still fails.
     *
     * Carries no price. Checkout is the gate: the server recomputes every term
     * from the real basket before anything is frozen.
     */
    starterOffer: starterOfferResponseSchema.optional(),
  })
  .strict();

export type CustomerEligibilityLookupRequest = z.infer<
  typeof customerEligibilityLookupRequestSchema
>;
export type CustomerEligibilityLookupResponse = z.infer<
  typeof customerEligibilityLookupResponseSchema
>;
