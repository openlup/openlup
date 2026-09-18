import { isAdminOmsSurfaceAllowed } from "./hiddenSurfaceAccess";

export const ADMIN_OMS_PREVIEW_FULFILLMENT_PROVIDER_KIND = "hidden_preview_fulfillment";

export function getAdminOmsFulfillmentProviderKind(
  env: Partial<Record<string, string | boolean | undefined>> = import.meta.env,
): string | null {
  return isAdminOmsSurfaceAllowed(env) ? ADMIN_OMS_PREVIEW_FULFILLMENT_PROVIDER_KIND : null;
}
