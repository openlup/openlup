/**
 * What one deployment settles in, read from an environment record.
 *
 * Extracted verbatim from `platformCurrency.ts`, which had grown to the edge of
 * its line budget while owning two separable jobs: *reading* the configuration,
 * and *deciding* with it. This module is the reading half — defaults, keys,
 * refusals, the profile shape, and the pure function that produces one. It
 * knows nothing about schemas or about which side of the wire is asking, so the
 * dependency runs one way: `platformCurrency.ts` imports from here and
 * re-exports every name, which is why no call site moved.
 *
 * `scripts/check-client-secret-boundary.test.ts` scans this file by name, along
 * with `platformCurrency.ts` and `fiscalProfile.ts`, and asserts that every
 * environment key spelled here matches a public bundle prefix. Moving the keys
 * without moving them under that scan would have quietly removed the assertion
 * that keeps a private key from being named in a bundled module.
 */
import { currencyExponent } from "./currencyExponent.js";
import {
  readFiscalProfile,
  readMinimumProductPayableMinor,
  type FiscalProfile,
} from "./fiscalProfile.js";

/** The currency this platform prices and settles in. */
export const PLATFORM_DEFAULT_CURRENCY = "PLN" as const;

/**
 * The environment key that names the currency this deployment settles in.
 *
 * `COMMERCE_` rather than `PLATFORM_` on purpose: only the prefixes listed in
 * `scripts/complexity-governance-env-flag-discovery.ts` are governed, and
 * `PLATFORM_` is not among them. A `PLATFORM_`-named key would be invisible to
 * the registry guard — droppable, renameable and misspellable with nothing
 * failing. The prefix is a governance namespace, not a statement about which
 * domain owns the concept.
 */
const SETTLEMENT_CURRENCY_ENV_KEY = "COMMERCE_SETTLEMENT_CURRENCY";

/**
 * The region this platform prices for, as an ISO 3166-1 alpha-2 code.
 *
 * It is a second stated fact rather than something computed from the settlement
 * currency, because that computation does not exist: nineteen countries settle
 * in the euro and several more in the dollar, so any derivation would have to
 * pick one. A guess wearing the costume of a lookup is precisely the silent
 * coercion this module exists to remove.
 */
export const PLATFORM_DEFAULT_REGION = "PL" as const;

/** The environment key that names the region this deployment prices for. */
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
  /** Which region's price lists the resolver reads; see {@link PLATFORM_DEFAULT_REGION}. */
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

/**
 * Reads the settlement profile from an environment record.
 *
 * Takes the record as an argument rather than reaching for the process
 * environment so that a browser bundle can hand it the record its bundler
 * substituted, a server process can hand it its own, and a test can hand it a
 * literal — the same read, no matter which side of the wire is asking.
 *
 * An **absent** key yields {@link PLATFORM_DEFAULT_CURRENCY}: that is the
 * documented behaviour, and it is what keeps every existing deployment exactly
 * where it is. A **present but malformed** value throws. The difference matters — silently correcting a
 * misconfigured currency to the default is the failure mode behind Vendure's
 * GHSA-wm63-7627, where an order is accepted at a price denominated in a
 * currency nobody validated. The region key follows the same rule, for the same
 * reason applied one layer down: a mistyped region selects the wrong price list.
 */
export function readSettlementProfile(
  env: Readonly<Record<string, string | undefined>> = {},
): SettlementProfile {
  const configured = env[SETTLEMENT_CURRENCY_ENV_KEY]?.trim();
  if (configured !== undefined && configured !== "" && !/^[A-Z]{3}$/.test(configured)) {
    throw new InvalidSettlementCurrencyError(configured);
  }

  const defaultCurrency = configured === undefined || configured === ""
    ? PLATFORM_DEFAULT_CURRENCY
    : configured;

  const configuredRegion = env[SETTLEMENT_REGION_ENV_KEY]?.trim();
  if (
    configuredRegion !== undefined && configuredRegion !== ""
    && !/^[A-Z]{2}$/.test(configuredRegion)
  ) {
    throw new InvalidSettlementRegionError(configuredRegion);
  }

  const regionCode = configuredRegion === undefined || configuredRegion === ""
    ? PLATFORM_DEFAULT_REGION
    : configuredRegion;

  return {
    defaultCurrency,
    acceptedCurrencies: [defaultCurrency],
    exponent: currencyExponent(defaultCurrency),
    regionCode,
    minimumProductPayableMinor: readMinimumProductPayableMinor(env, defaultCurrency),
    fiscalProfile: readFiscalProfile(env),
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
