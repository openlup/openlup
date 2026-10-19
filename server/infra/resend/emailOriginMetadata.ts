import {
  resolveEmailOrigin,
  type ResolvedEmailOrigin,
} from "../../../src/domains/communications/email/originPolicy.js";
import { APP_PRODUCTION_EMAIL_HOSTS, APP_SITE_ORIGIN } from "../../../src/lib/brand/appBrand.js";

export interface EmailOriginMetadataInput {
  baseUrl?: string | null;
  originSource?: string | null;
  environment?: string | null;
  platformJobRunId?: string | null;
  resolvedOrigin?: ResolvedEmailOrigin | null;
}

export function buildEmailOriginMetadata(input: EmailOriginMetadataInput): Record<string, string> {
  const resolvedOrigin = input.resolvedOrigin ?? resolveMetadataOrigin(input);
  return {
    emailBaseUrl: resolvedOrigin.origin,
    emailOriginSource: input.originSource ?? resolvedOrigin.source,
    emailEnvironment: input.environment ?? "unknown",
    ...(input.platformJobRunId ? { platformJobRunId: input.platformJobRunId } : {}),
  };
}

export function withEmailOriginMetadata(
  providerResponse: Record<string, unknown>,
  originMetadata: Record<string, string>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return { ...providerResponse, ...originMetadata, ...extra };
}

export function originFromUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function resolveMetadataOrigin(input: EmailOriginMetadataInput): ResolvedEmailOrigin {
  const resolved = resolveEmailOrigin({
    defaultOrigin: APP_SITE_ORIGIN,
    productionEmailHosts: APP_PRODUCTION_EMAIL_HOSTS,
    explicitBaseUrl: input.baseUrl,
    environment: input.environment,
    hiddenPreviewEnabled: input.environment === "hidden_preview",
  });
  if (resolved.ok === false) {
    throw new Error(`invalid_email_origin_metadata:${resolved.error}`);
  }
  return resolved.resolved;
}
