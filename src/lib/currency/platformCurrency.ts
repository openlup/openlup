/**
 * The platform's currency policy, in one place.
 *
 * The answer to "which currency do we accept?" used to be written down
 * independently in a dozen contract files; now there is one definition and
 * everything else aliases it. It lives in `src/lib` rather than in a domain
 * because commerce, catalog, customers and the checkout composer all consume
 * it, and putting it in any one of them would make the other three import
 * across a domain boundary.
 *
 * ⛔ Do NOT re-express the accepted set as `z.enum(...)` or `z.literal(...)`.
 * A closed union bakes the current answer into the *type system*, which is
 * exactly what this programme has to undo: the accepted list becomes
 * configuration and the predicate reads a settlement profile. A value-level
 * predicate lets that happen without touching a single call site, so the shape
 * here — three uppercase letters, then membership — is already the final one.
 *
 * The default and the accepted set stay two separate exports even while the set
 * has one member: "what do we price in" and "what will we take" are different
 * questions, and conflating them is how a platform acquires a currency
 * fallback — a payload in an unpriced currency quietly taken at the wrong
 * amount.
 *
 * Reading configuration is `./settlementProfile.js`; deciding with it is here.
 * Every name from there is re-exported below, so importers see one module.
 */
import { z } from "../validation/zod.js";
import { currencyExponent } from "./currencyExponent.js";
import {
  describesSameSettlement,
  PLATFORM_DEFAULT_CURRENCY,
  readSettlementProfile,
  type SettlementProfile,
} from "./settlementProfile.js";

export { currencyExponent, UnresolvableCurrencyExponentError } from "./currencyExponent.js";
export {
  InvalidSettlementCurrencyError,
  InvalidSettlementRegionError,
  PLATFORM_DEFAULT_CURRENCY,
  PLATFORM_DEFAULT_REGION,
  readSettlementProfile,
  type SettlementProfile,
} from "./settlementProfile.js";

/**
 * Every currency this platform will accept on an inbound contract. Today this
 * is exactly the default; the type is deliberately `readonly string[]` and not
 * a tuple so that widening it stays a data change, not a type change.
 */
export const PLATFORM_ACCEPTED_CURRENCIES: readonly string[] = [PLATFORM_DEFAULT_CURRENCY];

/**
 * Pure membership test. The accepted list is a parameter so callers that need a
 * different set (a sales channel, a later configuration read) inject it instead
 * of shadowing this module with their own copy.
 */
export function isAcceptedPlatformCurrency(
  code: string,
  accepted: readonly string[] = PLATFORM_ACCEPTED_CURRENCIES,
): boolean {
  return accepted.includes(code);
}

/** Widened alias for every contract field that used to carry a one-member union. */
export type PlatformCurrency = string;

/**
 * The environment this module can legally read, which is not the process one.
 *
 * `scripts/check-client-secret-boundary.ts` forbids naming the process
 * environment anywhere under `src/`, and rightly: this file is bundled into the
 * browser. `import.meta.env` is the record the bundler substitutes at build
 * time, carrying exactly the keys whose names match `PUBLIC_BUNDLE_ENV_PREFIXES`
 * in that same guard — the settlement, fiscal and payable-floor namespaces, and
 * nothing else.
 *
 * It is read whole rather than key by key. A hand-picked subset would be a
 * second list to keep in step with `readSettlementProfile` and
 * `readFiscalProfile`, and a stale subset fails *silently*: the browser would
 * derive its payable floor from the exponent while the server read the
 * configured one, and both would look right.
 *
 * The cast and the fallback are for the other side of the wire: `import.meta`
 * carries no `env` in a plain server process, so every server, cron and script
 * importer resolves `{}` here — which is why {@link initAmbientSettlementProfile}
 * exists.
 */
const bundleEnv: Readonly<Record<string, string | undefined>> =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

/**
 * Raised when one process is told twice, differently, what it settles in.
 *
 * Tolerating the second answer would mean the currency a payload is judged by
 * depends on which module happened to load first, which is a worse defect than
 * either answer being wrong on its own.
 */
export class ConflictingAmbientSettlementProfileError extends Error {
  readonly initialisedCurrency: string;
  readonly conflictingCurrency: string;

  constructor(initialised: SettlementProfile, conflicting: SettlementProfile) {
    super(
      `This process was already initialised to settle in ${initialised.defaultCurrency} and was ` +
        `then asked to settle in ${conflicting.defaultCurrency}. One process settles in one ` +
        `currency; refusing rather than letting load order decide which payloads are accepted.`,
    );
    this.name = "ConflictingAmbientSettlementProfileError";
    this.initialisedCurrency = initialised.defaultCurrency;
    this.conflictingCurrency = conflicting.defaultCurrency;
  }
}

/**
 * What this process settles in — the answer the ambient schema and the
 * presentation layer both read.
 *
 * In a bundle this is resolved once at load from the record the bundler
 * substituted, and never changes. In a plain server process that record does not
 * exist, so this starts at the platform default and stays there unless a
 * composition root calls {@link initAmbientSettlementProfile}. That default is
 * what every deployment already gets today, which is why a deployment settling
 * in the platform's own currency cannot observe this binding moving.
 *
 * It is a live binding rather than a constant so there is one answer per process
 * rather than two. Importers read it as a value exactly as before.
 */
export let ambientSettlementProfile: SettlementProfile = readSettlementProfile(bundleEnv);

/** The profile an explicit initialisation recorded, if one has happened. */
let initialisedProfile: SettlementProfile | undefined;

/**
 * Tells this process what it settles in, once, before it parses any money.
 *
 * A plain server process has no bundler-substituted environment, so without this
 * call the ambient schema answers for the platform default and refuses the
 * currency the deployment is actually configured for — correctly, from its own
 * point of view, and uselessly. Server composition roots call
 * `bootstrapAmbientSettlementProfile` (`server/runtime/settlementProfileBootstrap.ts`),
 * which reads the process environment — something this file may not do — and
 * hands the result here.
 *
 * Calling it twice with the same profile is fine: one process may boot more than
 * one path into this module. Calling it twice with *different* profiles throws,
 * because a process that disagrees with itself about its own currency would
 * accept or refuse the same payload depending on load order.
 *
 * Not calling it at all is the behaviour every deployment has today.
 */
export function initAmbientSettlementProfile(profile: SettlementProfile): void {
  if (initialisedProfile && !describesSameSettlement(initialisedProfile, profile)) {
    throw new ConflictingAmbientSettlementProfileError(initialisedProfile, profile);
  }
  initialisedProfile = profile;
  ambientSettlementProfile = profile;
}

/**
 * A currency schema bound to one settlement profile - the injection seam for
 * every caller that knows which deployment it is serving.
 *
 * {@link platformCurrencySchema} below is the *ambient* schema: it answers for
 * whatever this process resolved, from a bundled environment or from an explicit
 * initialisation. A caller that is serving a deployment it can name — a sales
 * channel, a test, a second tenant — passes that profile here instead and gets a
 * schema that cannot be moved by anything else.
 *
 * The profile may be a function, and the ambient schema passes one, because the
 * ambient answer is decided after this module loads and the refusal has to
 * follow it. Resolving per parse rather than closing over an object is what
 * makes initialisation possible at all; the cost is one property read on a path
 * that already runs a regular expression.
 *
 * Format first, so a malformed code is rejected as a malformed code, then
 * membership. The refusal names the reason rather than the set: "not accepted"
 * invites the question "accepted by whom?", whereas a deployment settles in one
 * currency and will not take another, and that is what an operator reading a
 * rejected payload needs to be told.
 */
export function createPlatformCurrencySchema(
  profile: SettlementProfile | (() => SettlementProfile),
) {
  const accepted = (): readonly string[] =>
    (typeof profile === "function" ? profile() : profile).acceptedCurrencies;
  return z
    .string()
    .regex(/^[A-Z]{3}$/)
    .refine((code) => isAcceptedPlatformCurrency(code, accepted()), {
      message: "currency_not_settlement_currency",
    });
}

/**
 * The single currency schema for every platform contract - the ambient one,
 * bound to whatever this process settles in.
 *
 * Acceptance is asked of the settlement profile rather than of
 * {@link PLATFORM_ACCEPTED_CURRENCIES}, which is what turns "which currencies
 * will we take" from a property of this repository into a property of this
 * deployment. The constant is still exported and still read by four other
 * consumers; what changed is that the schema is no longer one of them, so the
 * answer can move without moving theirs.
 *
 * Built through {@link createPlatformCurrencySchema} rather than repeating the
 * construction, so the ambient and injected schemas cannot drift — which they
 * briefly did: the two waves that introduced them landed the factory with the
 * older refusal message and the ambient schema with the newer one, and nothing
 * failed, because no test asserted the factory's message.
 */
export const platformCurrencySchema = createPlatformCurrencySchema(
  () => ambientSettlementProfile,
);
