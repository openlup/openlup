import { checkReadiness, type CandidateIdentity, type Contribution, type LoadedPackage, type ReadinessInput, type SchemaProbePort } from "@openlup/core/readiness";
import { createIdentityContribution, type EmailTrustPolicy, type IdentityVerifierPort, type CustomerMePort, type AdminAuthPort, type IdentityAdminActionsPort, type CustomerChallengeDeliveryPort, type PrivacyOperations, createAdminBffPreflight } from "@openlup/platform/identity";
import type { RouteEntry } from "@openlup/platform/bff";
import { withObservedRoute } from "../../_lib/observability/route.js";
import { MACHINE_ACTOR_WRITE_ROUTES, allowedAdminRolesForBffRoute } from "../../_lib/admin-domain/auth.js";
import { observeReferencePackages } from "../outbox/candidateAdmission.js";
import { assessIdentityReadiness } from "./identityReadiness.js";
import { identityRequiredSchema, type IdentityBundle } from "./identitySchema.js";

const dependencies = ["bff", "data", "kernel", "http"] as const;
const responsibilities = ["customerSession", "customerProfile", "operatorAuthorization", "operatorActions", "delivery", "privacy"] as const;
export type ReferenceIdentityPorts = {
  customerSession: IdentityVerifierPort;
  customerProfile: CustomerMePort;
  operatorAuthorization: AdminAuthPort;
  operatorActions: Pick<IdentityAdminActionsPort, "inviteAdminUser" | "removeAdminUser">;
  delivery: CustomerChallengeDeliveryPort;
  privacy: PrivacyOperations;
  emailTrustPolicy: EmailTrustPolicy;
};
const methods = {
  customerSession: ["verifyAccessToken"], customerProfile: ["getCustomerMe"], operatorAuthorization: ["authorize"],
  operatorActions: ["inviteAdminUser", "removeAdminUser"], delivery: ["deliver"], privacy: ["export", "erase"],
} as const;
/** Prepare one candidate from its mounted functions and selected adapters; construction does no I/O. */
export function createReferenceIdentity(input: {
  bundle: IdentityBundle;
  migrationIdentity: string;
  env: Record<string, string | undefined>;
  createRoutes(ports: ReferenceIdentityPorts, env: Record<string, string | undefined>): readonly RouteEntry[];
  ports: ReferenceIdentityPorts;
}) {
  const env = Object.freeze({ ...input.env });
  const ports = { ...input.ports };
  const routes = input.createRoutes(ports, env).map(route => ({ ...route,
    handler: withObservedRoute({ route: route.route, domain: "identity", surface: route.route.startsWith("/api/bff/admin/") ? "admin" : "customer", risk: "mutation" },
      async (req, res) => { await route.handler(req, res); }),
  }));
  const preflight = createAdminBffPreflight({
    allowedRoles: allowedAdminRolesForBffRoute, machineWriteRoutes: MACHINE_ACTOR_WRITE_ROUTES,
    resolveBinding: () => ({ binding: { identity: input.bundle, run: (_token, work) => work(ports.operatorAuthorization) } }),
  });
  return { env, preflight, bundle: input.bundle, routes, declaredRoutes: routes.map(route => ({ id: route.route, handle: route.handler })), ports, requiredSchema: identityRequiredSchema(input.bundle, input.migrationIdentity) };
}
export type ReferenceIdentity = ReturnType<typeof createReferenceIdentity>;
export type ReferenceIdentityAdmission = {
  runtime: ReferenceIdentity;
  candidate: CandidateIdentity;
  currentIdentity(): CandidateIdentity;
  schemaProbe: SchemaProbePort;
  /** Tests and custom loaders can supply independently observed package facts. */
  observed?: { loadedPackages: readonly LoadedPackage[]; inventoryComplete: boolean };
};
export async function admitReferenceIdentity(input: ReferenceIdentityAdmission) {
  const identity = { ...input.candidate };
  const observed = input.observed ?? observeReferencePackages();
  const installed = observed.loadedPackages;
  const version = installed.find(pkg => pkg.name === "@openlup/platform")?.version ?? "";
  const loadedPackages = installed.map(pkg => pkg.name === "@openlup/platform" ? { ...pkg, modules: [...dependencies, "identity"] } : pkg);
  const foundation: Contribution[] = dependencies.map(id => ({
    manifest: { name: "@openlup/platform", version, kind: "rail", module: { id, kind: "rail", provides: [`./${id}`], dependsOn: [] },
      emits: [], handles: [], schedules: [], routes: [], requiredPorts: [], env: [] }, handlers: [], schedules: [], routes: [],
  }));
  const contribution = createIdentityContribution({ version, requiredSchema: input.runtime.requiredSchema,
    routes: input.runtime.declaredRoutes, requiredPorts: responsibilities });
  const bindings: ReadinessInput["bindings"] = { triggers: {}, env: {},
    ports: { "@openlup/platform/identity:emailTrustPolicy": input.runtime.ports.emailTrustPolicy, ...Object.fromEntries(responsibilities.map(key => {
      const port = input.runtime.ports[key];
      const available = port && methods[key].every(method => typeof Reflect.get(port, method) === "function");
      return [`@openlup/platform/identity:${key}`, available ? port : null];
    })) },
    routes: Object.fromEntries(input.runtime.routes.map(route => [`@openlup/platform/identity:${route.route}`, route.handler])),
  };
  const report = await checkReadiness({ candidate: identity, loadedPackages, inventoryComplete: observed.inventoryComplete,
    contributions: [...foundation, contribution], bindings, schemaProbe: input.schemaProbe, vocabulary: [], exemptions: [] });
  const emailTrust = await assessIdentityReadiness(() => input.runtime.ports.emailTrustPolicy);
  const state = report.state === "unknown" || emailTrust.state === "unknown" ? "unknown"
    : report.state === "unsatisfied" || emailTrust.state === "unsatisfied" ? "unsatisfied" : "ready";
  const combined = { ...report, state, issues: [...report.issues, ...emailTrust.issues] } as const;
  const assertCurrent = () => {
    const current = input.currentIdentity();
    if (Object.keys(identity).some(key => identity[key as keyof CandidateIdentity] !== current[key as keyof CandidateIdentity])) throw new Error("identity_candidate_admission_stale");
  };
  return { admitted: state === "ready", report: combined, assertCurrent };
}
