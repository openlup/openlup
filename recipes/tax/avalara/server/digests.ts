import { createHash } from "node:crypto";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog/contracts";
import type { TaxCalculationEvidenceV1, TaxScopeV1 } from "@openlup/platform/tax/contracts";

const ISO_4217_REGEX = /^[A-Z]{3}$/u;

const SUPPORTED_ISO_CURRENCIES: ReadonlySet<string> = new Set(
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : [],
);

/**
 * Resolve ISO-4217 minor-unit exponent for a recognized 3-letter uppercase currency code
 * using standard runtime `Intl.supportedValuesOf("currency")` + `Intl.NumberFormat` metadata.
 * Rejects unrecognized codes (such as `"ZZZ"`, `"XXX"`, `"ABC"`) with `null`.
 */
export function getCurrencyExponent(currency: string): number | null {
  if (!ISO_4217_REGEX.test(currency)) return null;
  if (SUPPORTED_ISO_CURRENCIES.size > 0 && !SUPPORTED_ISO_CURRENCIES.has(currency)) {
    return null;
  }
  try {
    const digits = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits;
    return typeof digits === "number" && Number.isSafeInteger(digits) && digits >= 0 && digits <= 4
      ? digits
      : null;
  } catch {
    return null;
  }
}

/**
 * Exact integer minor-unit -> major-unit JSON number conversion using string scaling
 * to avoid binary floating-point rounding drift.
 */
export function minorToMajorAmount(minor: number, exponent: number): number {
  if (!Number.isSafeInteger(minor)) {
    throw new Error("avalara_invalid_minor_amount");
  }
  if (exponent === 0) return minor;
  const negative = minor < 0;
  const absStr = String(Math.abs(minor)).padStart(exponent + 1, "0");
  const splitIdx = absStr.length - exponent;
  const majorStr = `${negative ? "-" : ""}${absStr.slice(0, splitIdx)}.${absStr.slice(splitIdx)}`;
  const parsed = Number(majorStr);
  if (!Number.isFinite(parsed)) {
    throw new Error("avalara_invalid_major_amount");
  }
  return parsed;
}

/** Expand a finite JS number's decimal string (including scientific notation) into `{ negative, intDigits, fracDigits }`. */
function parseExactDecimalParts(major: number): {
  readonly negative: boolean;
  readonly intDigits: string;
  readonly fracDigits: string;
} {
  const negative = major < 0;
  const raw = Math.abs(major).toString().toLowerCase();
  const [mantissa, expPart] = raw.split("e");
  const shift = expPart ? Number.parseInt(expPart, 10) : 0;
  const [wholeRaw = "0", fracRaw = ""] = (mantissa ?? "0").split(".");
  const digits = `${wholeRaw}${fracRaw}`;
  const decimalPos = wholeRaw.length + shift;

  if (decimalPos <= 0) {
    return {
      negative,
      intDigits: "0",
      fracDigits: `${"0".repeat(-decimalPos)}${digits}`,
    };
  }
  if (decimalPos >= digits.length) {
    return {
      negative,
      intDigits: `${digits}${"0".repeat(decimalPos - digits.length)}`,
      fracDigits: "",
    };
  }
  return {
    negative,
    intDigits: digits.slice(0, decimalPos),
    fracDigits: digits.slice(decimalPos),
  };
}

function scaleDecimalHalfAwayFromZero(major: number, scale: number): number {
  if (typeof major !== "number" || !Number.isFinite(major)) {
    throw new Error("avalara_invalid_major_amount");
  }
  if (major === 0) return 0;

  const { negative, intDigits, fracDigits } = parseExactDecimalParts(major);
  const paddedFrac = fracDigits.padEnd(scale + 1, "0");
  const baseDigits = `${intDigits}${paddedFrac.slice(0, scale)}`;
  const roundDigit = paddedFrac.charCodeAt(scale) - 48; // '0'..'9'

  let magnitude = BigInt(baseDigits);
  if (roundDigit >= 5) {
    magnitude += 1n;
  }
  const signed = negative ? -magnitude : magnitude;
  const result = Number(signed);
  if (!Number.isSafeInteger(result)) {
    throw new Error("avalara_minor_amount_overflow");
  }
  return result === 0 ? 0 : result;
}

/**
 * Exact major-unit number -> integer minor-unit conversion via decimal-string digit parsing
 * and half-away-from-zero rounding (eliminating binary IEEE-754 half-cent drift such as
 * `35.855 -> 3586`, `10.075 -> 1008`, `-100.005 -> -10001`).
 */
export function majorToMinorAmount(major: number, exponent: number): number {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new Error("avalara_invalid_currency_exponent");
  }
  return scaleDecimalHalfAwayFromZero(major, exponent);
}

/**
 * Convert an Avalara fractional tax rate (e.g. `0.0825` = 8.25%) into a canonical
 * OpenLup `CatalogueMoneyV2` percentage-point rate decimal string (e.g. `"8.25"`),
 * stripping trailing fractional zeros and eliminating IEEE-754 representation noise.
 */
export function fractionalRateToPercentString(fractionalRate: number): string {
  if (typeof fractionalRate !== "number" || !Number.isFinite(fractionalRate) || fractionalRate < 0) {
    throw new Error("avalara_invalid_rate");
  }
  // Exact decimal shift right by 2 places (x 100), rounded half-away-from-zero to 6 fractional digits.
  const scaled = scaleDecimalHalfAwayFromZero(fractionalRate, 8); // fractionalRate * 100 * 1e6
  if (!Number.isSafeInteger(scaled) || scaled < 0) {
    throw new Error("avalara_invalid_rate");
  }
  const whole = Math.floor(scaled / 1e6);
  const frac = scaled % 1e6;
  if (frac === 0) {
    return String(whole);
  }
  const fracStr = String(frac).padStart(6, "0").replace(/0+$/u, "");
  return `${whole}.${fracStr}`;
}

/** Compute lowercase 64-hex SHA-256 over UTF-8 bytes of `canonicalCatalogDraftJson([tag, payload])`. */
export function taxTaggedDigest(tag: string, payload: unknown): string {
  return createHash("sha256")
    .update(canonicalCatalogDraftJson([tag, payload]), "utf8")
    .digest("hex");
}

export function computeResolutionDigest(
  resolution: TaxCalculationEvidenceV1["positions"]["tax"][number]["resolution"],
): string {
  return taxTaggedDigest("platform.tax.resolution.v1", resolution);
}

export function computeFiscalDigest(params: {
  readonly scope: TaxScopeV1;
  readonly destinationDigest: string;
  readonly shipFromRef: string;
  readonly policyRevision: string;
  readonly classMapRevision: string;
  readonly coverage: TaxCalculationEvidenceV1["coverage"]["vector"];
  readonly tax: TaxCalculationEvidenceV1["positions"]["tax"];
  readonly fees: TaxCalculationEvidenceV1["positions"]["fees"];
}): string {
  return taxTaggedDigest("platform.tax.fiscal.v1", {
    scope: params.scope,
    destinationDigest: params.destinationDigest,
    shipFromRef: params.shipFromRef,
    policyRevision: params.policyRevision,
    classMapRevision: params.classMapRevision,
    coverage: params.coverage,
    tax: params.tax.map(({ resolutionDigest: _rd, providerLineRef: _plr, ...row }) => row),
    fees: params.fees,
  });
}

export function computeEvidenceDigest(evidence: TaxCalculationEvidenceV1): string {
  return taxTaggedDigest("platform.tax.evidence.v1", evidence);
}

/** Deterministic AvaTax SalesInvoice code (`<= 50` chars, strictly ASCII alphanumeric + hyphen). */
export function buildAvalaraCommitCode(
  companyCode: string,
  scope: TaxScopeV1,
  transactionRef: string,
): string {
  const hash = taxTaggedDigest("platform.tax.commit.v1", [companyCode, scope, transactionRef]);
  return `ol-${hash.slice(0, 44)}`;
}

/** Deterministic AvaTax ReturnInvoice code (`<= 50` chars, strictly ASCII alphanumeric + hyphen). */
export function buildAvalaraReversalCode(
  companyCode: string,
  scope: TaxScopeV1,
  reversalRef: string,
): string {
  const hash = taxTaggedDigest("platform.tax.reverse.v1", [companyCode, scope, reversalRef]);
  return `ol-r-${hash.slice(0, 42)}`;
}
