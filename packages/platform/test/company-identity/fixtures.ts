import type { CompanyIdentityRules } from "../../src/company-identity/contracts/index.js";

/** Synthetic four-digit scheme; no real jurisdiction or provider policy. */
export const rules: CompanyIdentityRules = {
  normalizeIdentifier: (country, kind, value) => country === "ZZ" && kind === "national"
    ? value.replace(/^ZZ\s*/, "").replace(/-/g, "") : value,
  isValidIdentifier: (country, kind, value) => country === "ZZ" && kind === "national"
    ? /^\d{4}$/.test(value) && (Number(value[0]) + Number(value[1]) + Number(value[2])) % 10 === Number(value[3])
    : value.trim().length > 0,
  isFullerLegalName: (next, current) => Boolean(next && current && next.length > current.length && next.includes(current)),
  shouldSeekFullerLegalName: (request, company) => request.country === "ZZ" && request.identifierKind === "national" && company.legalName === "Alfa Beta",
};
