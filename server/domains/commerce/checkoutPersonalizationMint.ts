import type { VercelResponse } from "../../_lib/types/vercel.js";
import type { PersonalizationOnPersistHook } from "./configuratorIntentPersistenceHandler.js";

// Best-effort /v2 hero personalization at checkout: mint the signed `openlup_pid`
// identity + `openlup_pzn` hint cookies and precompute the declension for the client
// this checkout just provisioned — so a completion that SKIPPED the configurator
// contact step (e.g. a resumed link, or before the early-lead mint landed) is
// still recognised on the next /v2 visit. The early-lead route
// (POST /api/bff/personalization/lead) is the primary trigger; this is the
// idempotent belt-and-suspenders on every checkout completion.
//
// Additive + non-fatal by contract: every failure is swallowed and NEVER affects
// checkout. `syncLlmOnMiss` is left OFF on this path (the injected hook resolves
// dictionary-inline and enqueues the async outbox on a miss) so checkout NEVER
// waits on an LLM call.

export interface ApplyCheckoutPersonalizationInput {
  res: VercelResponse;
  clientId: string;
  ownerName: string | null;
  dogName: string | null;
  personalizationOnPersist?: PersonalizationOnPersistHook;
  mintPersonalizationCookies?: (clientId: string) => string[];
}

export async function applyCheckoutPersonalization({
  res,
  clientId,
  ownerName,
  dogName,
  personalizationOnPersist,
  mintPersonalizationCookies,
}: ApplyCheckoutPersonalizationInput): Promise<void> {
  if (mintPersonalizationCookies) {
    try {
      const cookies = mintPersonalizationCookies(clientId);
      if (cookies.length > 0) appendSetCookie(res, cookies);
    } catch (error) {
      console.warn(
        "[checkout] personalization cookie mint failed (non-fatal)",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (personalizationOnPersist) {
    try {
      await personalizationOnPersist.onNamesPersisted({
        clientId,
        primaryPetId: null,
        ownerName,
        dogName,
      });
    } catch (error) {
      console.warn(
        "[checkout] personalization precompute failed (non-fatal)",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/** Append cookies to any Set-Cookie already staged on the response (never clobber). */
function appendSetCookie(res: VercelResponse, cookies: string[]): void {
  const existing = res.getHeader("Set-Cookie");
  const prior = Array.isArray(existing)
    ? existing.map(String)
    : existing != null
      ? [String(existing)]
      : [];
  res.setHeader("Set-Cookie", [...prior, ...cookies]);
}
