import { buildEmailOriginMetadata as build, type EmailOriginMetadataInput } from "@openlup/platform/communications";
import { APP_PRODUCTION_EMAIL_HOSTS, APP_SITE_ORIGIN } from "../../../src/lib/brand/appBrand.js";
export { withEmailOriginMetadata, originFromUrl } from "@openlup/platform/communications";
export type { EmailOriginMetadataInput } from "@openlup/platform/communications";
export function buildEmailOriginMetadata(input: EmailOriginMetadataInput): Record<string, string> {
  return build(input, { defaultOrigin: APP_SITE_ORIGIN, productionEmailHosts: APP_PRODUCTION_EMAIL_HOSTS });
}
