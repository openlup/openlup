import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APPLICATION_DOMAINS,
  CORE_DOMAINS,
  DOMAIN_REGISTRY,
  defineDomainRegistry,
  isApplicationDomain,
  isCoreDomain,
} from "./coreDomains.js";
import { APPLICATION_DOMAINS as PUBLIC_APPLICATION_DOMAINS } from "./exampleApplicationDomains.js";

const DOMAIN_ROOTS = ["src/domains", "server/domains"] as const;

function domainDirectories(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe("domain registry", () => {
  it.each(DOMAIN_ROOTS)("classifies every directory under %s", (root) => {
    const unclassified = domainDirectories(root).filter((name) => DOMAIN_REGISTRY.classify(name) === null);
    expect(unclassified).toEqual([]);
  });

  it("names only core domains that exist as a directory", () => {
    const present = new Set(DOMAIN_ROOTS.flatMap(domainDirectories));
    expect(CORE_DOMAINS.filter((name) => !present.has(name))).toEqual([]);
  });

  it("keeps the public application-domain binding empty", () => {
    expect(PUBLIC_APPLICATION_DOMAINS).toEqual([]);
  });

  it("exposes the bound application domains as a frozen, disjoint list", () => {
    expect(Object.isFrozen(APPLICATION_DOMAINS)).toBe(true);
    expect(APPLICATION_DOMAINS.filter((name) => isCoreDomain(name))).toEqual([]);
    expect(APPLICATION_DOMAINS.every((name) => isApplicationDomain(name))).toBe(true);
  });

  it("lets a deployment register its own domains beside the core ones", () => {
    const registry = defineDomainRegistry(["example-loyalty", "example-rentals"]);

    expect(registry.application).toEqual(["example-loyalty", "example-rentals"]);
    expect(registry.classify("example-loyalty")).toBe("application");
    expect(registry.classify("payment")).toBe("core");
    expect(registry.classify("unknown")).toBeNull();
    expect(registry.core).toBe(CORE_DOMAINS);
  });

  it("refuses an application domain that redefines a core one", () => {
    expect(() => defineDomainRegistry(["payment"])).toThrow(/already a core domain/);
  });

  it("refuses a domain registered twice", () => {
    expect(() => defineDomainRegistry(["example-loyalty", "example-loyalty"])).toThrow(/registered twice/);
  });

  it.each(["", "Example", "example_loyalty", "-example", "example-", "../example"])(
    "refuses %j as a domain directory name",
    (name) => {
      expect(() => defineDomainRegistry([name])).toThrow(/not a valid domain directory name/);
    },
  );
});
