import { APPLICATION_DOMAINS as BOUND_APPLICATION_DOMAINS } from "#application-domains";

/**
 * The domain directories the platform ships under `src/domains` and
 * `server/domains`. Each is generic commerce or subscription behaviour and a
 * candidate neutral kernel: it names no deployment and reaches into no
 * application copy, route or provider.
 *
 * A deployment's own domains are application domains. They are registered
 * through `#application-domains` (the public binding is
 * `src/lib/exampleApplicationDomains.ts`, which names none), never by editing
 * this list.
 */
export const CORE_DOMAINS = Object.freeze([
  "accounting",
  "address-canon",
  "auth",
  "bundle",
  "catalog",
  "channels",
  "checkout",
  "clients",
  "commerce",
  "communications",
  "company-identity",
  "customers",
  "fulfillment",
  "inventory",
  "marketing",
  "observability",
  "partners",
  "payment",
  "platform",
  "platform-runtime",
  "pricing",
  "promo",
  "risk",
  "shipping",
  "subscription",
  "support",
] as const);

export type CoreDomain = (typeof CORE_DOMAINS)[number];
export type DomainKind = "core" | "application";

/** A domain name is its directory name: lower-case words joined by hyphens. */
export const DOMAIN_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface DomainRegistry {
  readonly core: readonly CoreDomain[];
  readonly application: readonly string[];
  classify(name: string): DomainKind | null;
}

/**
 * Builds the registry for one deployment. Application domains must be valid
 * directory names, unique, and distinct from every core domain, so a deployment
 * can add domains but cannot redefine one the platform owns.
 */
export function defineDomainRegistry(applicationDomains: readonly string[]): DomainRegistry {
  const core = new Set<string>(CORE_DOMAINS);
  const application = new Set<string>();
  for (const name of applicationDomains) {
    if (typeof name !== "string" || !DOMAIN_NAME_PATTERN.test(name)) {
      throw new Error(`Application domain ${JSON.stringify(name)} is not a valid domain directory name`);
    }
    if (core.has(name)) throw new Error(`Application domain "${name}" is already a core domain`);
    if (application.has(name)) throw new Error(`Application domain "${name}" is registered twice`);
    application.add(name);
  }
  const applicationList = Object.freeze([...application]);
  return Object.freeze({
    core: CORE_DOMAINS,
    application: applicationList,
    classify(name: string): DomainKind | null {
      if (core.has(name)) return "core";
      if (application.has(name)) return "application";
      return null;
    },
  });
}

/** The registry of this deployment: the core domains plus the bound application domains. */
export const DOMAIN_REGISTRY = defineDomainRegistry(BOUND_APPLICATION_DOMAINS);

export const APPLICATION_DOMAINS = DOMAIN_REGISTRY.application;

export function isCoreDomain(name: string): name is CoreDomain {
  return DOMAIN_REGISTRY.classify(name) === "core";
}

export function isApplicationDomain(name: string): boolean {
  return DOMAIN_REGISTRY.classify(name) === "application";
}
