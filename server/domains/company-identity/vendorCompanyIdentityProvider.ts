import { createHash } from "node:crypto";

import type {
  CompanyIdentityCompany,
  CompanyIdentityLookupRequest,
} from "../../../src/domains/company-identity/companyIdentityContracts.js";
import type { CompanyIdentityProvider } from "./companyIdentityService.js";

export interface VendorCompanyIdentityConfig {
  baseUrl: string;
  path: string;
  apiToken: string | null;
  timeoutMs: number;
  providerKind: string;
}

export function readVendorCompanyIdentityConfig(
  env: Record<string, string | undefined>,
): VendorCompanyIdentityConfig | null {
  if (env.COMPANY_IDENTITY_VENDOR_ENABLED !== "true") return null;
  const baseUrl = env.COMPANY_IDENTITY_VENDOR_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) return null;
  return {
    baseUrl,
    path: env.COMPANY_IDENTITY_VENDOR_LOOKUP_PATH?.trim() || "/company-identity/lookup",
    apiToken: env.COMPANY_IDENTITY_VENDOR_API_TOKEN?.trim() || null,
    timeoutMs: positiveInt(env.COMPANY_IDENTITY_VENDOR_TIMEOUT_MS, 5_000),
    providerKind: env.COMPANY_IDENTITY_VENDOR_PROVIDER_KIND?.trim() || "commercial_company_lookup",
  };
}

export function createVendorCompanyIdentityProvider(
  config: VendorCompanyIdentityConfig,
  fetchImpl: typeof fetch = fetch,
): CompanyIdentityProvider {
  return {
    providerKind: config.providerKind,
    async lookup(request) {
      try {
        const body = await requestVendor(fetchImpl, config, request);
        const company = mapVendorCompany(body, request);
        return {
          status: company?.legalName && company.registeredAddress ? "found" : company ? "partial" : "not_found",
          company,
          source: {
            providerKind: config.providerKind,
            status: company?.legalName && company.registeredAddress ? "found" : company ? "partial" : "not_found",
            observedAt: new Date().toISOString(),
            evidenceHash: company ? hashEvidence({ providerKind: config.providerKind, company }) : null,
          },
        };
      } catch {
        return {
          status: "provider_unavailable",
          company: null,
          source: {
            providerKind: config.providerKind,
            status: "provider_unavailable",
            observedAt: new Date().toISOString(),
            evidenceHash: null,
          },
        };
      }
    },
  };
}

async function requestVendor(
  fetchImpl: typeof fetch,
  config: VendorCompanyIdentityConfig,
  request: CompanyIdentityLookupRequest,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const url = new URL(config.path, config.baseUrl);
    const response = await fetchImpl(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(config.apiToken ? { Authorization: `Bearer ${config.apiToken}` } : {}),
      },
      body: JSON.stringify({
        country: request.country,
        identifierKind: request.identifierKind,
        identifierValue: request.identifierValue,
      }),
    });
    if (!response.ok) throw new Error(`vendor_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function mapVendorCompany(body: unknown, request: CompanyIdentityLookupRequest): CompanyIdentityCompany | null {
  const raw = isRecord(body) && isRecord(body.company) ? body.company : isRecord(body) ? body : null;
  if (!raw) return null;
  const address = isRecord(raw.registeredAddress) || isRecord(raw.address)
    ? (raw.registeredAddress ?? raw.address) as Record<string, unknown>
    : null;
  return {
    country: request.country,
    identifierKind: request.identifierKind,
    identifierValue: readString(raw, "identifierValue", "taxId", "nip") ?? request.identifierValue,
    legalName: readString(raw, "legalName", "name", "companyName"),
    registeredAddress: address ? {
      line1: readString(address, "line1", "street", "addressLine") ?? "",
      postalCode: readString(address, "postalCode", "zip") ?? "",
      city: readString(address, "city", "locality", "town") ?? "",
      country: readString(address, "country") ?? request.country,
    } : null,
    registryStatus: readString(raw, "registryStatus", "status"),
    regon: readString(raw, "regon"),
    vatStatus: readString(raw, "vatStatus"),
  };
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hashEvidence(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
