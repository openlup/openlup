import type { Contribution, RequiredSchema } from "@openlup/core/readiness";

/** Descriptors only: owner messages, workers and schedules stay with their owners. */
export function createAccountSupportContribution(input: {
  version: string;
  requiredSchema: RequiredSchema;
  accountSupport: Readonly<Record<string, ((...args: never[]) => unknown) | null>>;
  dependsOn: NonNullable<Contribution["manifest"]["module"]>["dependsOn"];
  routes?: Contribution["routes"];
}) {
  const routes = [...input.routes ?? []];
  if (new Set(routes.map(route => route.id)).size !== routes.length) throw new Error("account_support_duplicate_route");
  const contribution: Contribution = {
    manifest: {
      name: "@openlup/platform", version: input.version, kind: "rail",
      module: { id: "account-support", kind: "capability", provides: ["./account-support", "./account-support/contracts"], dependsOn: input.dependsOn },
      emits: [], handles: [], schedules: [], env: [], requiredPorts: Object.keys(input.accountSupport),
      routes: routes.map(route => route.id), requiredSchema: input.requiredSchema,
    }, handlers: [], schedules: [], routes,
  };
  return {
    contributions: [contribution],
    ports: Object.fromEntries(Object.entries(input.accountSupport).filter(([, operation]) => operation !== null)
      .map(([key, operation]) => [`@openlup/platform/account-support:${key}`, operation])),
    routes: Object.fromEntries(routes.map(route => [`@openlup/platform/account-support:${route.id}`, route.handle])),
    triggers: {},
  };
}
