import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  CUSTOMER_ELIGIBILITY_CONTRACT_VERSION,
  customerEligibilityLookupRequestSchema,
  customerEligibilityLookupResponseSchema,
} from "../../../src/domains/commerce/customerEligibilityContracts.js";
import { starterOfferResponseFor } from "../../../src/domains/commerce/starterOfferContracts.js";

export interface CustomerEligibilityResolution {
  clientId: string | null;
  source: "anonymous" | "resolved_client";
  /**
   * How the client matched the typed email. Only an EXACT-email match with paid
   * order history surfaces returning-buyer recognition; a `"plus_normalized"`
   * match (a `+tag` alias folding onto a base mailbox) resolves a client for
   * first-order eligibility ONLY and is never reported as `recognized`.
   */
  matchKind?: "exact" | "plus_normalized" | null;
}

export interface CommerceCustomerEligibilityHandlerDeps {
  /** Resolve email → existing client (reuses the quote's email resolver). */
  resolveCustomerEligibility: (input: {
    email: string;
  }) => Promise<CustomerEligibilityResolution>;
  /** Server-authoritative paid-order counts for the resolved client. */
  countPaidOrdersByMode: (
    clientId: string,
  ) => Promise<{ oneTime: number; subscription: number }>;
  /**
   * Optional rate-limit gate. Fail-closed: a blocked request returns RATE_LIMITED.
   * The FE recognition hook fails soft (treats any error as "new customer"), so a
   * blocked lookup never breaks the flow — it just skips the recognition banner.
   */
  checkRateLimit?: (
    req: VercelRequest,
    email: string,
  ) => Promise<{ allowed: boolean }>;
  /**
   * Server-side starter-pack gate (`COMMERCE_STARTER_PACK_ENABLED`). Omitted or
   * false means the response never grows the `starterOffer` field, whatever the
   * client asked for.
   */
  starterPackEnabled?: () => boolean;
}

/**
 * Early customer recognition + first-order eligibility lookup (pre-pricing).
 *
 * Returns only two booleans (no PII, no client id). `recognized` powers the
 * "we know your account — sign in" banner; `firstOrderEligible` lets the UI
 * reason about the discount. The price itself still comes from the quote
 * endpoint (single source of truth) — this endpoint only annotates.
 *
 * `recognized` requires an EXACT-email match with paid-order history. A guest
 * typing a `+tag` alias of an existing mailbox is not told that the base mailbox
 * has purchased before. A plus-alias match still resolves a client for
 * eligibility (below) but never for recognition.
 *
 * Eligibility is email-authoritative (matches the quote's device-guard demotion):
 * a resolved client with zero paid orders — or no matching client at all — is
 * first-order eligible regardless of the device cookie. The plus-normalized match
 * is retained here on purpose so a `+alias` cannot farm a fresh first-order price.
 */
export function createCommerceCustomerEligibilityHandler(
  deps: CommerceCustomerEligibilityHandlerDeps,
) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const parsed = customerEligibilityLookupRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid customer eligibility request", {
        details: parsed.error.flatten(),
      });
      return;
    }
    const { email, offerModeCapability } = parsed.data;

    if (deps.checkRateLimit) {
      const verdict = await deps.checkRateLimit(req, email);
      if (!verdict.allowed) {
        sendBffError(res, "RATE_LIMITED", "Too many eligibility lookups");
        return;
      }
    }

    try {
      const eligibility = await deps.resolveCustomerEligibility({ email });
      let recognized = false;
      let firstOrderEligible = true;
      if (eligibility.clientId) {
        const byMode = await deps.countPaidOrdersByMode(eligibility.clientId);
        const paidOrderCount = byMode.oneTime + byMode.subscription;
        // Recognition is reserved for an EXACT-email returning buyer. A resolved
        // lead with no paid order remains first-order eligible and must not see the
        // account banner. A `plus_normalized` match still uses the same paid count
        // for anti-farming, but never surfaces recognition.
        recognized = eligibility.matchKind === "exact" && paidOrderCount > 0;
        firstOrderEligible = paidOrderCount === 0;
      }

      // Two independent conditions, both required: the client has to understand
      // the offer (capability) AND the server has to be serving it (flag).
      // Either one missing leaves the response deep-equal to the pre-capability
      // contract — no key, not a `false` key.
      const starterPackOn = offerModeCapability !== undefined && (deps.starterPackEnabled?.() ?? false);

      const response = customerEligibilityLookupResponseSchema.parse({
        contractVersion: CUSTOMER_ELIGIBILITY_CONTRACT_VERSION,
        recognized,
        firstOrderEligible,
        ...(starterPackOn
          ? { starterOffer: starterOfferResponseFor(firstOrderEligible) }
          : {}),
      });
      sendBffSuccess(res, response, {
        contractVersion: CUSTOMER_ELIGIBILITY_CONTRACT_VERSION,
      });
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer eligibility lookup failed");
    }
  };
}
