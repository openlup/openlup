import { destinationV2Capabilities } from "@openlup/platform/commerce/server/destinations";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { createEcommerceEventPrivacyContributor } from '@openlup/platform/communications';
import { randomUUID } from "node:crypto";
import { createPostgresPrivacyUnitOfWork, createPostgresPrivacyStore, createManagedPrivacyStore, createIdentityPersonalDataContributor,
  createPersonalDataContributorRegistry, createPrivacyOperations, createPrivacyExportHandler, createPrivacyEraseHandler,
  createDestinationReceiptPrivacyContributor, createDestinationDocumentPrivacyContributor, createTaxCalculationPrivacyContributor,
  createCustomerSavedAddressPrivacyContributor, createCustomerPreferencePrivacyContributor, isNativePrivacyOperations,
  nativePrivacyUnavailable, privacyRefusalDetails, readBearerToken, createFulfillmentParcelContactPrivacyContributor,
  createCustomerBillingPrivacyContributor, type ManagedIdentityClient, type IdentityPrivacyPolicy, type NativePrivacyStore,
  type PrivacyStore, type PrivacyUseCaseDependencies } from "@openlup/platform/identity";
import type { HttpRequest, HttpResponse } from "@openlup/platform/http";
import { resolveAdminAuthBinding } from "./adminAuthBinding.js";
import { createSubscriptionsPrivacyContributor, verifyMissingSubscriptionsPrivacySubject } from "./subscriptionsPrivacyContributor.js";
import { createServiceRoleClient, resolveSupabaseServiceRoleEnv } from "../../_lib/admin-domain/auth.js";
import { sendBffError } from "../../_lib/bff/response.js";
import { readObservedResponseContext } from "../../_lib/observability/requestContext.js";
const policy: IdentityPrivacyPolicy = { retainedContactFields: Object.fromEntries(["lifecycle_stage", "acquisition_source"].map(field => [field, {
  owner: "clients", resource: `clients.${field}`, disposition: "retain" as const, reasonCode: "CONTACT_LIFECYCLE_RETENTION", remote: false,
}])) };
const nativeUnavailable = "Check the native app binding, database connection and TLS, runtime CONNECT and EXECUTE privileges, and installed migrations. Then retry the same operation.";

export function nativePrivacyContributors(store: PrivacyStore<PgQueryExecutor>) {
  return [createIdentityPersonalDataContributor(store, policy, randomUUID), createSubscriptionsPrivacyContributor(),
    createFulfillmentParcelContactPrivacyContributor(), createCustomerBillingPrivacyContributor(),
    createEcommerceEventPrivacyContributor(), createDestinationReceiptPrivacyContributor(), createDestinationDocumentPrivacyContributor(),
    createCustomerSavedAddressPrivacyContributor(), createCustomerPreferencePrivacyContributor(), createTaxCalculationPrivacyContributor()];
}

export function composeNativePrivacy(
  deps: Pick<PrivacyUseCaseDependencies<PgQueryExecutor>, "unitOfWork"> & { store: NativePrivacyStore<PgQueryExecutor> },
  destination: { installed?: boolean; issuanceEnabled?: boolean } = {},
) {
  const registry = createPersonalDataContributorRegistry(nativePrivacyContributors(deps.store), { requiredContributorIds: [
    "identity", "subscriptions", "fulfillment-parcel-contacts", "customer-billing", "communication-events",
    "destination-receipts", "destination-documents", "customer-saved-addresses", "customer-preferences", "tax-calculations",
  ] });
  const operations = createPrivacyOperations({ ...deps, registry, verifyMissingSubject: verifyMissingSubscriptionsPrivacySubject,
    now: () => new Date(), randomId: randomUUID });
  if (!isNativePrivacyOperations(operations)) throw nativePrivacyUnavailable(new Error("native_privacy_operations_required"));
  return {
    operations, registry,
    destination: destinationV2Capabilities({ ...destination, rail: "native", privacyRegistry: registry }),
  };
}
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
      let operations;
      try {
        if (!env.DATABASE_URL?.trim()) throw new Error("privacy_database_required");
        const unitOfWork = createPostgresPrivacyUnitOfWork({ connectionString: env.DATABASE_URL }); close = unitOfWork.close;
        operations = composeNativePrivacy({ store: createPostgresPrivacyStore(), unitOfWork }).operations;
      } catch (cause) {
        res.setHeader("Cache-Control", "no-store");
        return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Privacy operation refused", { details: privacyRefusalDetails(nativePrivacyUnavailable(cause)) });
      }
      return await createHandler({ authorizeAdmin, responseRequestId, operations, unavailableMessage: nativeUnavailable })(req, res);
    }
    const service = resolveSupabaseServiceRoleEnv(env);
    if (!service) throw new Error("privacy_service_required");
    const client = createServiceRoleClient(service) as unknown as ManagedIdentityClient;
    const store = createManagedPrivacyStore();
    const registry = createPersonalDataContributorRegistry([createIdentityPersonalDataContributor(store, policy, randomUUID)], { requiredContributorIds: ["identity", "subscriptions"] });
    return await createHandler({ authorizeAdmin, responseRequestId, operations: createPrivacyOperations({ store, registry, unitOfWork: { run: work => work(client) }, now: () => new Date(), randomId: randomUUID }) })(req, res);
  } catch {
    return sendBffError(res, "UPSTREAM_UNAVAILABLE", env.PLATFORM_BUNDLE === "node-postgres" ? nativeUnavailable : "Privacy operation unavailable");
  }
  finally { await close?.(); }
}
