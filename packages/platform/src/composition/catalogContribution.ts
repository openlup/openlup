import type { Contribution, RequiredSchema } from "@openlup/core/readiness";

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
  for (const module of ["catalog", "pricing", "promotions"] as const) {
    const selected = input[module];
    for (const [name, callable] of Object.entries(selected)) ports[`@openlup/platform/${module}:${name}`] = callable;
    contributions.push({
      manifest: {
        name: "@openlup/platform", version: input.version, kind: "rail",
        module: { id: module, kind: "capability", provides: [`./${module}`], dependsOn: [] },
        emits: [], handles: [], schedules: [], env: [], requiredPorts: Object.keys(selected),
        routes: module === "catalog" ? input.routes.map(route => route.id) : [],
        ...(module === "catalog" ? { requiredSchema: input.requiredSchema } : {}),
      },
      handlers: [], schedules: [], routes: module === "catalog" ? input.routes : [],
    });
  }
  return { contributions, ports, routes: Object.fromEntries(input.routes.map(route => [`@openlup/platform/catalog:${route.id}`, route.handle])) };
}
