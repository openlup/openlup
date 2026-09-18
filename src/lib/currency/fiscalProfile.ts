/**
 * What this deployment invoices under, and the smallest amount it will sell for.
 *
 * Both used to be constants: a tax profile named after this shop's product
 * category, and a payable floor written as the literal `100`. Neither is a
 * platform fact. The floor in particular was not even a floor - it was *one
 * major unit* frozen at an exponent of two, which is a hundredfold
 * overstatement in any currency that has no hundredths.
 *
 * These live beside the currency module rather than inside it because that file
 * is two lines under the repository's source-size cap, and beside rather than
 * under `src/domains/commerce/` because the settlement profile is read by
 * commerce, catalog and the checkout composer alike; putting it in any one of
 * them would make the other two import across a domain boundary.
 *
 * `COMMERCE_` rather than `PLATFORM_` on every key below, for the reason E2-F0
 * established: only the prefixes in `GOVERNED_PREFIXES` are enforced by the
 * env/flag discovery guard, so a `PLATFORM_`-named key would be droppable,
 * renameable and misspellable with nothing failing.
 */
import { currencyExponent } from "./currencyExponent.js";

/**
 * The VAT treatment a document is issued under. Structurally identical to
 * `CommerceTaxProfile`, and deliberately not an import of it: this module sits
 * below the domains and is consumed by the settlement profile, which the domains
 * consume in turn.
 */
export type FiscalProfile = {
  readonly included: true;
  /** The jurisdiction whose tax law the document is issued under, ISO 3166-1 alpha-2. */
  readonly country: string;
  /** Which supply the rate applies to; the reduced rate below is category-specific. */
  readonly category: string;
  readonly vatRateBps: number;
  readonly legalBasis: string;
};

const FISCAL_COUNTRY_ENV_KEY = "COMMERCE_FISCAL_COUNTRY";
const FISCAL_CATEGORY_ENV_KEY = "COMMERCE_FISCAL_CATEGORY";
const FISCAL_VAT_RATE_BPS_ENV_KEY = "COMMERCE_FISCAL_VAT_RATE_BPS";
const FISCAL_LEGAL_BASIS_ENV_KEY = "COMMERCE_FISCAL_LEGAL_BASIS";
const MINIMUM_PRODUCT_PAYABLE_ENV_KEY = "COMMERCE_MIN_PRODUCT_PAYABLE_MINOR";

/**
 * The reference deployment's fiscal facts, and the value every unset key falls
 * back to. It states its jurisdiction rather than borrowing the settlement
 * region: the region selects which price list is read, the jurisdiction names
 * whose tax law the invoice cites, and a platform that sells from one country's
 * list into another's regime is an ordinary arrangement - the quote port's own
 * tests pin exactly that case.
 */
export const PLATFORM_DEFAULT_FISCAL_PROFILE: FiscalProfile = {
  included: true,
  country: "PL",
  category: "pet_food",
  vatRateBps: 800,
  legalBasis: "PL VAT Annex 3 item 10c",
};

/** Raised when configuration names a fiscal fact the platform cannot make sense of. */
export class InvalidFiscalProfileError extends Error {
  readonly envKey: string;
  readonly configuredValue: string;

  constructor(envKey: string, configuredValue: string, expectation: string) {
    super(
      `${envKey}=${JSON.stringify(configuredValue)} is not ${expectation}. Refusing to fall ` +
        `back to the platform default: a deployment that invoices under a tax treatment ` +
        `nobody chose issues wrong documents to a tax authority, which is not a mistake a ` +
        `later correction fully undoes.`,
    );
    this.name = "InvalidFiscalProfileError";
    this.envKey = envKey;
    this.configuredValue = configuredValue;
  }
}

/** Raised when configuration names a payable floor that is not a positive whole amount. */
export class InvalidMinimumProductPayableError extends Error {
  readonly configuredValue: string;

  constructor(configuredValue: string) {
    super(
      `${MINIMUM_PRODUCT_PAYABLE_ENV_KEY}=${JSON.stringify(configuredValue)} is not a positive ` +
        `integer number of minor units. Refusing to fall back: the floor decides which ` +
        `discounts a quote may apply, so a value read as zero would let a promotion drive a ` +
        `line to a price nobody approved.`,
    );
    this.name = "InvalidMinimumProductPayableError";
    this.configuredValue = configuredValue;
  }
}

/**
 * Reads the fiscal profile from an environment record.
 *
 * Same absent-versus-malformed rule as the rest of the settlement profile: an
 * **absent** key yields the documented default, which is what keeps every
 * existing deployment exactly where it is; a **present but malformed** value
 * throws by name. Silently correcting a misconfigured fiscal fact to this
 * shop's own is how a platform issues one jurisdiction's reduced-rate invoice in
 * a country that has no such rate.
 *
 * The four keys are independent on purpose. A deployment that keeps the rate but
 * cites a different statute, or keeps the statute but sells a different
 * category, should not have to restate the facts that did not move.
 */
export function readFiscalProfile(
  env: Readonly<Record<string, string | undefined>> = {},
): FiscalProfile {
  const country = readText(env, FISCAL_COUNTRY_ENV_KEY, PLATFORM_DEFAULT_FISCAL_PROFILE.country);
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new InvalidFiscalProfileError(
      FISCAL_COUNTRY_ENV_KEY, country, "an ISO 3166-1 alpha-2 code (two uppercase letters)",
    );
  }

  const rawRate = env[FISCAL_VAT_RATE_BPS_ENV_KEY]?.trim();
  return {
    included: true,
    country,
    category: readText(env, FISCAL_CATEGORY_ENV_KEY, PLATFORM_DEFAULT_FISCAL_PROFILE.category),
    vatRateBps: rawRate === undefined || rawRate === ""
      ? PLATFORM_DEFAULT_FISCAL_PROFILE.vatRateBps
      : parseBasisPoints(rawRate),
    legalBasis: readText(env, FISCAL_LEGAL_BASIS_ENV_KEY, PLATFORM_DEFAULT_FISCAL_PROFILE.legalBasis),
  };
}

function parseBasisPoints(raw: string): number {
  if (!/^\d{1,5}$/.test(raw) || Number(raw) > 10_000) {
    throw new InvalidFiscalProfileError(
      FISCAL_VAT_RATE_BPS_ENV_KEY, raw, "a whole number of basis points from 0 to 10000",
    );
  }
  return Number(raw);
}

/**
 * The smallest amount a product line may be sold for, in minor units.
 *
 * Configuration first: a floor is a commercial decision and a deployment must be
 * able to state one. Absent, it is **derived** as one major unit -
 * `10 ** exponent` - which is exactly what the literal `100` it replaces was
 * expressing, and which yields `1` rather than `100` for a currency with no
 * hundredths. A constant default would have reproduced the same hundredfold
 * error the moment the currency moved and nobody thought to set the key; a
 * derivation cannot be wrong in a way an operator has to notice.
 *
 * It is **not** read from `commerce_settings.min_product_payable_minor`. That
 * row is, in its own migration's words, the database-side mirror of this
 * profile, read by the SQL functions that need it in SQL. This function is pure
 * and synchronous and is called on the quote path; giving it a table to read
 * would put a round-trip in front of every price and make the floor unavailable
 * whenever the database is.
 */
export function readMinimumProductPayableMinor(
  env: Readonly<Record<string, string | undefined>>,
  currency: string,
): number {
  const configured = env[MINIMUM_PRODUCT_PAYABLE_ENV_KEY]?.trim();
  if (configured === undefined || configured === "") return 10 ** currencyExponent(currency);
  if (!/^\d+$/.test(configured) || Number(configured) < 1) {
    throw new InvalidMinimumProductPayableError(configured);
  }
  return Number(configured);
}

// An empty or all-whitespace value is treated as absent rather than as a
// refusal, because that is exactly what an unset key looks like in
// `.env.example` and in a shell that exports a blank - the same rule the
// settlement currency and region already follow. The category and the legal
// basis have no malformed state beyond that: they are free text a jurisdiction
// writes, and this platform is in no position to tell a valid citation from an
// invalid one. Their refusal, when there is one, comes from the tax authority.
function readText(
  env: Readonly<Record<string, string | undefined>>, key: string, fallback: string,
): string {
  const configured = env[key]?.trim();
  return configured === undefined || configured === "" ? fallback : configured;
}
