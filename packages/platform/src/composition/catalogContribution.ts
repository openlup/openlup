import type { Contribution, RequiredSchema } from "@openlup/core/readiness";
import { buildCapabilityContribution } from "./buildCapabilityContribution.js";

/** Actual selected callables, supplied by the host; declarations never activate them. */
export interface CatalogContributionInput {
  version: string;
  requiredSchema: RequiredSchema;
  catalog: Readonly<Record<string, (...args: never[]) => unknown>>;
  pricing: Readonly<Record<string, (...args: never[]) => unknown>>;
  promotions: Readonly<Record<string, (...args: never[]) => unknown>>;
  routes: Contribution["routes"];
}

/** Thin structural declarations under the existing logical module identities. */
export function createCatalogContribution(input: CatalogContributionInput) {
  const contributions: Contribution[] = [];
  const ports: Record<string, unknown> = {};
  let routes: { [k: string]: (...args: never[]) => unknown } = {};
  for (const module of ["catalog", "pricing", "promotions"] as const) {
    const built = buildCapabilityContribution({
      id: module,
      version: input.version,
      provides: [`./${module}`],
      dependsOn: [],
      ...(module === "catalog" ? { requiredSchema: input.requiredSchema, routes: input.routes } : {}),
      ports: input[module],
      includePort: () => true,
    });
    contributions.push(built.contribution);
    Object.assign(ports, built.ports);
    if (module === "catalog") {
      routes = built.routes;
    }
  }
  return { contributions, ports, routes };
}
