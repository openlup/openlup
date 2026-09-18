// Runtime loader for the OmniPack merchant dictionary.
//
// OmniPack does NOT expose a carriers/services dictionary endpoint (confirmed
// against api.omnipack.tech v1.3.0 / v2.0.0 docs: the carrier/service dictionary
// is "specified by OmniPack" per merchant, out-of-band). So the authoritative
// runtime source is config the operator pastes from OmniPack: the env var
// OMNIPACK_MERCHANT_DICTIONARY_JSON (Vercel-safe, per-environment), validated by
// the existing validateOmnipackMerchantDictionary contract. A missing/invalid
// dictionary yields null so no carrier/service codes are ever guessed from a
// half-parsed dictionary.
//
// ⚠️ null does NOT mean "no options offered". resolveDeliverySelectionPort then
// falls through to the DECLARED PRODUCTION CARRIER SET
// (`OMNIPACK_DELIVERY_OPTIONS`) — the branch production actually runs, where
// every declared route is enabled by declaration. Read that factory before
// reasoning about what customers are offered.
import {
  validateOmnipackMerchantDictionary,
  type OmnipackMerchantDictionary,
} from "./merchantDictionary.js";

export interface LoadedOmnipackMerchantDictionary {
  ok: boolean;
  dictionary: OmnipackMerchantDictionary | null;
  source: "env" | "none";
  blocked: string[];
}

export function loadOmnipackMerchantDictionary(
  env: Record<string, string | undefined> = process.env,
): LoadedOmnipackMerchantDictionary {
  const raw = env.OMNIPACK_MERCHANT_DICTIONARY_JSON?.trim();
  if (!raw) {
    return { ok: false, dictionary: null, source: "none", blocked: ["merchant_dictionary_not_configured"] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, dictionary: null, source: "env", blocked: ["merchant_dictionary_invalid_json"] };
  }

  const validation = validateOmnipackMerchantDictionary(parsed);
  return {
    ok: validation.ok,
    dictionary: validation.dictionary,
    source: "env",
    blocked: validation.blocked.map((blocker) => `${blocker.reason}:${blocker.target}`),
  };
}

// Allowlist of carrier KINDS enabled for customers. Raw parse only — the CALLER
// decides what an empty set means, and the two callers differ on purpose:
//   - dictionary branch: the dictionary can carry the provider's full
//     portfolio, so empty => fail-closed (no carrier offered); enabling one is
//     an explicit operator action.
//   - declared-production-set branch: the code already names the merchant-
//     confirmed carriers, so empty => all of them, and a non-empty value only
//     narrows. See server/bff/shipping/deliverySelectionFactory.ts.
export function readOmnipackEnabledCarriers(
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  return new Set(
    (env.OMNIPACK_ENABLED_CARRIERS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}
