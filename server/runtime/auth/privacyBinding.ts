import { randomUUID } from "node:crypto";
import { createPostgresPrivacyUnitOfWork, createPostgresPrivacyStore, createManagedPrivacyStore, createIdentityPersonalDataContributor,
  createPersonalDataContributorRegistry, createPrivacyOperations, createPrivacyExportHandler, createPrivacyEraseHandler,
  readBearerToken, type ManagedIdentityClient, type IdentityPrivacyPolicy } from "@openlup/platform/identity";
import type { HttpRequest, HttpResponse } from "@openlup/platform/http";
import { resolveAdminAuthBinding } from "./adminAuthBinding.js";
import { createSubscriptionsPrivacyContributor } from "./subscriptionsPrivacyContributor.js";
import { createServiceRoleClient, resolveSupabaseServiceRoleEnv } from "../../_lib/admin-domain/auth.js";
import { sendBffError } from "../../_lib/bff/response.js";
import { readObservedResponseContext } from "../../_lib/observability/requestContext.js";
const policy: IdentityPrivacyPolicy = { retainedContactFields: Object.fromEntries(["lifecycle_stage", "acquisition_source"].map(field => [field, {
  owner: "clients", resource: `clients.${field}`, disposition: "retain" as const, reasonCode: "CONTACT_LIFECYCLE_RETENTION", remote: false,
}])) };
export async function handlePrivacyRequest(operation: "export" | "erase", req: HttpRequest, res: HttpResponse, env: Record<string, string | undefined>): Promise<unknown> {
  let close: (() => Promise<void>) | undefined;
  try {
    const binding = resolveAdminAuthBinding(env).binding;
    if (!binding) throw new Error("privacy_auth_unconfigured");
    const token = readBearerToken(req);
    const authorizeAdmin = () => binding.run(token, auth => auth.authorize(token, { allowedRoles: ["admin"] }));
    const responseRequestId = (response: HttpResponse) => readObservedResponseContext(response)?.requestId;
    const createHandler = operation === "erase" ? createPrivacyEraseHandler : createPrivacyExportHandler;
    if (env.PLATFORM_BUNDLE === "node-postgres") {
      if (!env.DATABASE_URL?.trim()) throw new Error("privacy_database_required");
      const unitOfWork = createPostgresPrivacyUnitOfWork({ connectionString: env.DATABASE_URL }); close = unitOfWork.close;
      const store = createPostgresPrivacyStore();
      const registry = createPersonalDataContributorRegistry([createIdentityPersonalDataContributor(store, policy, randomUUID), createSubscriptionsPrivacyContributor()], { requiredContributorIds: ["identity", "subscriptions"] });
      return await createHandler({ authorizeAdmin, responseRequestId, operations: createPrivacyOperations({ store, unitOfWork, registry, now: () => new Date(), randomId: randomUUID }) })(req, res);
    }
    const service = resolveSupabaseServiceRoleEnv(env);
    if (!service) throw new Error("privacy_service_required");
    const client = createServiceRoleClient(service) as unknown as ManagedIdentityClient;
    const store = createManagedPrivacyStore();
    const registry = createPersonalDataContributorRegistry([createIdentityPersonalDataContributor(store, policy, randomUUID)], { requiredContributorIds: ["identity", "subscriptions"] });
    return await createHandler({ authorizeAdmin, responseRequestId, operations: createPrivacyOperations({ store, registry, unitOfWork: { run: work => work(client) }, now: () => new Date(), randomId: randomUUID }) })(req, res);
  } catch { return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Privacy operation unavailable"); }
  finally { await close?.(); }
}
