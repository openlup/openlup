import { createHash } from "node:crypto";

import type {
  InvoiceDataLookupRequest,
  InvoiceDataLookupResponse,
  InvoiceDataLookupVatStatus,
} from "../../../src/domains/accounting/invoiceContracts.js";
import type { InvoiceDataLookupPort } from "../../../src/domains/accounting/ports.js";

export interface MfVatLookupConfig {
  baseUrl: string;
  timeoutMs: number;
  providerKind: string;
}

export const MF_VAT_LOOKUP_BASE_URL = "https://wl-api.mf.gov.pl";

export class MfVatLookupError extends Error {
  constructor(readonly code: string, readonly status: number | null = null) {
    super("MF VAT invoice data lookup provider failed");
    this.name = "MfVatLookupError";
  }
}

export function readMfVatLookupConfig(
  env: Record<string, string | undefined>,
): MfVatLookupConfig {
  return {
    baseUrl: (env.MF_VAT_LOOKUP_BASE_URL?.trim() || MF_VAT_LOOKUP_BASE_URL).replace(/\/+$/, ""),
    timeoutMs: readPositiveInteger(env.MF_VAT_LOOKUP_TIMEOUT_MS, 5_000),
    providerKind: env.MF_VAT_LOOKUP_PROVIDER_KIND?.trim() || "mf_vat_whitelist",
  };
}

export function createMfVatInvoiceDataLookupPort(
  config: MfVatLookupConfig = readMfVatLookupConfig({}),
  fetchImpl: typeof fetch = fetch,
): InvoiceDataLookupPort {
  return {
    async lookupInvoiceData(request) {
      const body = await requestLookup(fetchImpl, config, request);
      return mapMfVatLookupResponse(body, request, config.providerKind);
    },
  };
}

export function mapMfVatLookupResponse(
  body: unknown,
  request: InvoiceDataLookupRequest,
  providerKind = "mf_vat_whitelist",
): InvoiceDataLookupResponse {
  const subject = readSubject(body);
  if (!subject) return emptyResponse(request, providerKind, "not_found");

  const legalName = readString(subject, "name");
  const regon = readString(subject, "regon");
  const vatStatus = mapVatStatus(readString(subject, "statusVat"));
  const address = mapAddress(readString(subject, "workingAddress") ?? readString(subject, "residenceAddress"));
  const source = "mf_vat_whitelist";
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
  config: MfVatLookupConfig,
  request: InvoiceDataLookupRequest,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const url = new URL(`/api/search/nip/${request.taxId}`, config.baseUrl);
    url.searchParams.set("date", new Date().toISOString().slice(0, 10));
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new MfVatLookupError(`http_${response.status}`, response.status);
    return await response.json();
  } catch (error) {
    if (error instanceof MfVatLookupError) throw error;
    throw new MfVatLookupError("network_or_timeout", null);
  } finally {
    clearTimeout(timeout);
  }
}

function readSubject(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  const result = body.result;
  if (!isRecord(result)) return null;
  return isRecord(result.subject) ? result.subject : null;
}

function mapAddress(value: string | null): InvoiceDataLookupResponse["address"] {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  const parts = normalized.split(",").map((part) => part.trim()).filter(Boolean);
  const cityPart = parts[parts.length - 1] ?? "";
  const street = parts.length > 1 ? parts.slice(0, -1).join(", ") : "";
  const postalMatch = /(\d{2}-\d{3})\s+(.+)/.exec(cityPart);
  if (!street || !postalMatch) return null;
  return {
    line1: street,
    postalCode: postalMatch[1],
    city: titleCasePolish(postalMatch[2]),
    country: "PL",
  };
}

function mapVatStatus(value: string | null): InvoiceDataLookupVatStatus {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (["czynny", "active"].includes(normalized)) return "active";
  if (["zwolniony", "exempt"].includes(normalized)) return "exempt";
  if (["niezarejestrowany", "not_registered", "not active"].includes(normalized)) return "not_registered";
  return "unknown";
}

function emptyResponse(
  request: InvoiceDataLookupRequest,
  providerKind: string,
  status: "not_found" | "provider_unavailable",
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

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function titleCasePolish(value: string): string {
  return value
    .toLocaleLowerCase("pl-PL")
    .split(" ")
    .map((part) => part ? `${part[0].toLocaleUpperCase("pl-PL")}${part.slice(1)}` : part)
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
