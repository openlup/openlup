import type { Contribution, RequiredSchema } from "@openlup/core/readiness";
import { buildCapabilityContribution } from "./buildCapabilityContribution.js";

/** Descriptors only: owner messages, workers and schedules stay with their owners. */
export function createAccountSupportContribution(input: {
  version: string;
  requiredSchema: RequiredSchema;
  accountSupport: Readonly<Record<string, ((...args: never[]) => unknown) | null>>;
  dependsOn: NonNullable<Contribution["manifest"]["module"]>["dependsOn"];
  routes?: Contribution["routes"];
}) {
  const routes = [...input.routes ?? []];
  const built = buildCapabilityContribution({
    id: "account-support",
    version: input.version,
    provides: ["./account-support", "./account-support/contracts"],
    dependsOn: input.dependsOn,
    requiredSchema: input.requiredSchema,
    ports: input.accountSupport,
    includePort: (operation) => operation !== null,
    routes,
    routeDuplicateError: "account_support_duplicate_route",
  });
  return {
    contributions: [built.contribution],
    ports: built.ports as { [k: string]: ((...args: never[]) => unknown) | null },
    routes: built.routes,
    triggers: {},
  };
}
