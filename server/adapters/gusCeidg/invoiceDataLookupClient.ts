import { createHash } from "node:crypto";

import type {
  InvoiceDataLookupRequest,
  InvoiceDataLookupResponse,
  InvoiceDataLookupVatStatus,
} from "../../../src/domains/accounting/invoiceContracts.js";
import type { InvoiceDataLookupPort } from "../../../src/domains/accounting/ports.js";

export interface GusCeidgLookupConfig {
  baseUrl: string;
  path: string;
  apiToken: string | null;
  timeoutMs: number;
  providerKind: string;
}

export class GusCeidgLookupError extends Error {
  constructor(readonly code: string, readonly status: number | null = null) {
    super("Invoice data lookup provider failed");
    this.name = "GusCeidgLookupError";
  }
}

export function readGusCeidgLookupConfig(
  env: Record<string, string | undefined>,
): GusCeidgLookupConfig | null {
  if (env.GUS_CEIDG_LOOKUP_ENABLED !== "true") return null;
  const baseUrl = env.GUS_CEIDG_LOOKUP_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) return null;
  return {
    baseUrl,
    path: env.GUS_CEIDG_LOOKUP_PATH?.trim() || "/invoice-data-lookup",
    apiToken: env.GUS_CEIDG_LOOKUP_API_TOKEN?.trim() || null,
    timeoutMs: readPositiveInteger(env.GUS_CEIDG_LOOKUP_TIMEOUT_MS, 5_000),
    providerKind: env.GUS_CEIDG_LOOKUP_PROVIDER_KIND?.trim() || "gus_ceidg_http",
  };
}

export function createGusCeidgInvoiceDataLookupPort(
  config: GusCeidgLookupConfig,
  fetchImpl: typeof fetch = fetch,
): InvoiceDataLookupPort {
  return {
    async lookupInvoiceData(request) {
      const body = await requestLookup(fetchImpl, config, request);
      return mapGusCeidgLookupResponse(body, request, config.providerKind);
    },
  };
}

export function createUnavailableInvoiceDataLookupPort(
  providerKind = "gus_ceidg_http",
): InvoiceDataLookupPort {
  return {
    async lookupInvoiceData(request) {
      return emptyResponse(request, providerKind, "provider_unavailable");
    },
  };
}

export function mapGusCeidgLookupResponse(
  body: unknown,
  request: InvoiceDataLookupRequest,
  providerKind = "gus_ceidg_http",
): InvoiceDataLookupResponse {
  const raw = selectCandidate(body);
  if (!raw) return emptyResponse(request, providerKind, "not_found");

  const status = readString(raw, "status", "statusPodmiotu")?.toLowerCase();
  if (status && ["not_found", "missing", "brak", "nie_znaleziono"].includes(status)) {
    return emptyResponse(request, providerKind, "not_found");
  }
  if (status && ["ambiguous", "many", "wiele"].includes(status)) {
    return emptyResponse(request, providerKind, "ambiguous");
  }

  const legalName = readString(raw, "legalName", "name", "companyName", "nazwa", "nazwaPelna");
  const regon = readString(raw, "regon", "REGON");
  const vatStatus = mapVatStatus(readString(raw, "vatStatus", "statusVat", "statusVAT"));
  const address = mapAddress(raw);
  const source = readString(raw, "source", "zrodlo") ?? "gus_ceidg_http";
  const evidenceHash = hashEvidence({
    taxId: request.taxId,
    legalName,
    regon,
    vatStatus,
    address,
    source,
  });

  if (!legalName || !address) {
    return {
      ...emptyResponse(request, providerKind, "not_found"),
      source,
      regon,
      vatStatus,
      evidenceHash,
    };
  }

  return {
    status: "found",
    providerKind,
    taxId: request.taxId,
    source,
    legalName,
    regon,
    vatStatus,
    address,
    evidenceHash,
    observedAt: new Date().toISOString(),
  };
}

async function requestLookup(
  fetchImpl: typeof fetch,
  config: GusCeidgLookupConfig,
  request: InvoiceDataLookupRequest,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const url = new URL(config.path, config.baseUrl);
    url.searchParams.set("taxId", request.taxId);
    url.searchParams.set("country", request.country);
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(config.apiToken ? { Authorization: `Bearer ${config.apiToken}` } : {}),
      },
    });
    if (!response.ok) throw new GusCeidgLookupError(`http_${response.status}`, response.status);
    return await response.json();
  } catch (error) {
    if (error instanceof GusCeidgLookupError) throw error;
    throw new GusCeidgLookupError("network_or_timeout", null);
  } finally {
    clearTimeout(timeout);
  }
}

function selectCandidate(body: unknown): Record<string, unknown> | null {
  if (Array.isArray(body)) return body.length === 1 && isRecord(body[0]) ? body[0] : null;
  if (!isRecord(body)) return null;
  const data = body.data ?? body.result ?? body.podmiot ?? body.company ?? body;
  if (Array.isArray(data)) return data.length === 1 && isRecord(data[0]) ? data[0] : null;
  return isRecord(data) ? data : null;
}

function mapAddress(raw: Record<string, unknown>): InvoiceDataLookupResponse["address"] {
  const nested = firstRecord(raw.address, raw.adres, raw.siedziba) ?? raw;
  const line1 = readString(nested, "line1", "street", "ulica", "adres", "addressLine");
  const building = readString(nested, "buildingNumber", "nrBudynku", "building");
  const unit = readString(nested, "unitNumber", "nrLokalu", "unit");
  const postalCode = readString(nested, "postalCode", "kodPocztowy", "zip");
  const city = readString(nested, "city", "miejscowosc", "locality", "town");
  const country = readString(nested, "country", "kraj") ?? "PL";
  const normalizedLine = [line1, building, unit ? `/${unit}` : null]
    .filter(Boolean)
    .join(" ")
    .replace(" /", "/")
    .trim();
  if (!normalizedLine || !postalCode || !city || country !== "PL") return null;
  return { line1: normalizedLine, postalCode, city, country: "PL" };
}

function mapVatStatus(value: string | null): InvoiceDataLookupVatStatus {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (["active", "czynny", "vat_czynny"].includes(normalized)) return "active";
  if (["exempt", "zwolniony", "vat_zwolniony"].includes(normalized)) return "exempt";
  if (["not_registered", "niezarejestrowany", "not active"].includes(normalized)) return "not_registered";
  return "unknown";
}

function emptyResponse(
  request: InvoiceDataLookupRequest,
  providerKind: string,
  status: "not_found" | "ambiguous" | "provider_unavailable",
): InvoiceDataLookupResponse {
  return {
    status,
    providerKind,
    taxId: request.taxId,
    source: providerKind,
    legalName: null,
    regon: null,
    vatStatus: "unknown",
    address: null,
    evidenceHash: null,
    observedAt: new Date().toISOString(),
  };
}

function hashEvidence(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    if (isRecord(value)) return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
