import { currencyExponent } from "./currencyExponent.js";
import {
  readFiscalProfile,
  readMinimumProductPayableMinor,
  type FiscalProfile,
} from "./fiscalProfile.js";

const SETTLEMENT_CURRENCY_ENV_KEY = "COMMERCE_SETTLEMENT_CURRENCY";

const SETTLEMENT_REGION_ENV_KEY = "COMMERCE_SETTLEMENT_REGION";

/** Raised when configuration names a settlement currency that is not a currency code. */
export class InvalidSettlementCurrencyError extends Error {
  readonly configuredValue: string;

  constructor(configuredValue: string) {
    super(
      `${SETTLEMENT_CURRENCY_ENV_KEY}=${JSON.stringify(configuredValue)} is not an ISO 4217 code ` +
        `(expected three uppercase letters). Refusing to fall back to the platform default: a ` +
        `deployment that prices in a currency nobody chose is worse than one that will not start.`,
    );
    this.name = "InvalidSettlementCurrencyError";
    this.configuredValue = configuredValue;
  }
}

/** Raised when configuration names a settlement region that is not a region code. */
export class InvalidSettlementRegionError extends Error {
  readonly configuredValue: string;

  constructor(configuredValue: string) {
    super(
      `${SETTLEMENT_REGION_ENV_KEY}=${JSON.stringify(configuredValue)} is not an ISO 3166-1 ` +
        `alpha-2 code (expected two uppercase letters). Refusing to fall back to the platform ` +
        `default: the region selects which price list the resolver reads, so a typo would ` +
        `either price from the wrong list or from none at all, silently.`,
    );
    this.name = "InvalidSettlementRegionError";
    this.configuredValue = configuredValue;
  }
}

/**
 * What this deployment settles in, resolved once from configuration.
 *
 * Six fields, and complete: the two that E2-F0 declared as "coming with the wave
 * that can populate them from something real" have arrived, so a reader no
 * longer has to tell a field that is not due yet from one somebody forgot.
 */
export type SettlementProfile = {
  readonly defaultCurrency: string;
  readonly acceptedCurrencies: readonly string[];
  readonly exponent: number;
  /** Which region's price lists the resolver reads. */
  readonly regionCode: string;
  /**
   * The smallest amount a product line may be sold for, in minor units. Derived
   * from the exponent unless configured, so a currency without hundredths gets a
   * floor of one minor unit rather than a hundred of them.
   */
  readonly minimumProductPayableMinor: number;
  /** The VAT treatment documents are issued under; a stated fact, not a lookup from the region. */
  readonly fiscalProfile: FiscalProfile;
};

/** Caller-owned fallback facts; no market is selected by this package. */
export type SettlementProfileFallbacks = {
  readonly defaultCurrency: string;
  readonly regionCode: string;
  readonly fiscalProfile: FiscalProfile;
};

/** Blank/absent environment values use the explicit fallbacks; malformed values refuse. */
export function readSettlementProfile(
  env: Readonly<Record<string, string | undefined>>,
  fallbacks: SettlementProfileFallbacks,
): SettlementProfile {
  const configured = env[SETTLEMENT_CURRENCY_ENV_KEY]?.trim();
  if (configured !== undefined && configured !== "" && !/^[A-Z]{3}$/.test(configured)) {
    throw new InvalidSettlementCurrencyError(configured);
  }

  const defaultCurrency = configured === undefined || configured === ""
    ? fallbacks.defaultCurrency
    : configured;

  const configuredRegion = env[SETTLEMENT_REGION_ENV_KEY]?.trim();
  if (
    configuredRegion !== undefined && configuredRegion !== ""
    && !/^[A-Z]{2}$/.test(configuredRegion)
  ) {
    throw new InvalidSettlementRegionError(configuredRegion);
  }

  const regionCode = configuredRegion === undefined || configuredRegion === ""
    ? fallbacks.regionCode
    : configuredRegion;

  return {
    defaultCurrency,
    acceptedCurrencies: [defaultCurrency],
    exponent: currencyExponent(defaultCurrency),
    regionCode,
    minimumProductPayableMinor: readMinimumProductPayableMinor(env, defaultCurrency),
    fiscalProfile: readFiscalProfile(env, fallbacks.fiscalProfile),
  };
}

/**
 * Do two profiles describe the same deployment?
 *
 * Used by the one-time ambient initialiser to tell a harmless repeat — two paths
 * into the same process, both reading the same environment — from the one thing
 * that must never be tolerated: two answers to "what does this deployment settle
 * in" inside a single process. Compared field by field rather than by identity,
 * because every reader produces a fresh object.
 */
export function describesSameSettlement(a: SettlementProfile, b: SettlementProfile): boolean {
  return a.defaultCurrency === b.defaultCurrency
    && a.regionCode === b.regionCode
    && a.exponent === b.exponent
    && a.minimumProductPayableMinor === b.minimumProductPayableMinor
    && a.acceptedCurrencies.length === b.acceptedCurrencies.length
    && a.acceptedCurrencies.every((code, index) => code === b.acceptedCurrencies[index])
    && JSON.stringify(a.fiscalProfile) === JSON.stringify(b.fiscalProfile);
}
