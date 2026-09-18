import { createHash } from "node:crypto";

import type {
  InvoiceDataLookupRequest,
  InvoiceDataLookupResponse,
} from "../../../src/domains/accounting/invoiceContracts.js";
import type { InvoiceDataLookupPort } from "../../../src/domains/accounting/ports.js";

/**
 * Official CEIDG (Centralna Ewidencja i Informacja o Działalności Gospodarczej)
 * lookup adapter, v3 API at https://dane.biznes.gov.pl/api/ceidg/v3.
 *
 * Why this exists: the MF VAT whitelist (`mfVat` adapter) only exposes the
 * sole-proprietor's *personal* name (e.g. "BARTŁOMIEJ ROSZKOWSKI"). The full
 * registered business name (e.g. "Zero to One Bartłomiej Roszkowski") lives in
 * CEIDG under `firma.nazwa`. The company-identity service already prefers a
 * fuller sole-proprietor name when a later provider supplies one — this adapter
 * is that later provider for PL/NIP lookups.
 *
 * Auth is a Bearer JWT issued to a registered CEIDG API account
 * (`CEIDG_API_TOKEN`); without it the provider stays unconfigured and the chain
 * falls back to MF VAT only.
 */
export interface CeidgLookupConfig {
  baseUrl: string;
  apiToken: string;
  timeoutMs: number;
  providerKind: string;
}

export const CEIDG_LOOKUP_BASE_URL = "https://dane.biznes.gov.pl/api/ceidg/v3";

export class CeidgLookupError extends Error {
  constructor(readonly code: string, readonly status: number | null = null) {
    super("CEIDG invoice data lookup provider failed");
    this.name = "CeidgLookupError";
  }
}

export function readCeidgLookupConfig(
  env: Record<string, string | undefined>,
): CeidgLookupConfig | null {
  const apiToken = env.CEIDG_API_TOKEN?.trim();
  if (!apiToken) return null;
  return {
    baseUrl: (env.CEIDG_LOOKUP_BASE_URL?.trim() || CEIDG_LOOKUP_BASE_URL).replace(/\/+$/, ""),
    apiToken,
    // CEIDG's first (cold) call routinely takes 6-8s; the BFF function allows
    // 30s, so default generously to avoid a cold-start timeout silently falling
    // back to the MF VAT personal-only name. Warm calls return in <1s.
    timeoutMs: readPositiveInteger(env.CEIDG_LOOKUP_TIMEOUT_MS, 12_000),
    providerKind: env.CEIDG_LOOKUP_PROVIDER_KIND?.trim() || "ceidg_v3",
  };
}

export function createCeidgInvoiceDataLookupPort(
  config: CeidgLookupConfig,
  fetchImpl: typeof fetch = fetch,
): InvoiceDataLookupPort {
  return {
    async lookupInvoiceData(request) {
      const body = await requestLookup(fetchImpl, config, request);
      return mapCeidgLookupResponse(body, request, config.providerKind);
    },
  };
}

export function mapCeidgLookupResponse(
  body: unknown,
  request: InvoiceDataLookupRequest,
  providerKind = "ceidg_v3",
): InvoiceDataLookupResponse {
  const firms = readFirms(body);
  if (!firms.length) return emptyResponse(request, providerKind, "not_found");

  // Prefer an active entry; CEIDG can return historical/withdrawn duplicates.
  const firm = firms.find((entry) => isActiveStatus(readString(entry, "status"))) ?? firms[0];

  const legalName = readString(firm, "nazwa");
  const owner = firstRecord(firm.wlasciciel, firm.wspolnik) ?? firm;
  const regon = readString(owner, "regon") ?? readString(firm, "regon");
  const address = mapAddress(firstRecord(firm.adresDzialalnosci, firm.adresGlownegoMiejscaWykonywaniaDzialalnosci, firm.adresKorespondencyjny));
  const source = "ceidg_v3";
  const evidenceHash = hashEvidence({ taxId: request.taxId, legalName, regon, address, source });

  if (!legalName || !address) {
    return {
      ...emptyResponse(request, providerKind, "not_found"),
      source,
      regon,
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
    // CEIDG does not attest VAT registration; MF VAT covers that dimension and
    // the company-identity service merges the two providers' fields.
    vatStatus: "unknown",
    address,
    evidenceHash,
    observedAt: new Date().toISOString(),
  };
}

async function requestLookup(
  fetchImpl: typeof fetch,
  config: CeidgLookupConfig,
  request: InvoiceDataLookupRequest,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const url = new URL(`${config.baseUrl}/firmy`);
    url.searchParams.set("nip", request.taxId);
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.apiToken}`,
      },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new CeidgLookupError(`http_${response.status}`, response.status);
    return await response.json();
  } catch (error) {
    if (error instanceof CeidgLookupError) throw error;
    throw new CeidgLookupError("network_or_timeout", null);
  } finally {
    clearTimeout(timeout);
  }
}

function readFirms(body: unknown): Record<string, unknown>[] {
  if (!isRecord(body)) return [];
  const firms = body.firmy ?? body.firma ?? body.data;
  if (Array.isArray(firms)) return firms.filter(isRecord);
  return isRecord(firms) ? [firms] : [];
}

function mapAddress(raw: Record<string, unknown> | null): InvoiceDataLookupResponse["address"] {
  if (!raw) return null;
  const street = readString(raw, "ulica");
  const building = readString(raw, "budynek", "nrNieruchomosci");
  const unit = readString(raw, "lokal", "nrLokalu");
  const postalCode = readString(raw, "kod", "kodPocztowy");
  const city = readString(raw, "miasto", "miejscowosc");
  const line1 = [street, building, unit ? `/${unit}` : null]
    .filter(Boolean)
    .join(" ")
    .replace(" /", "/")
    .trim();
  if (!line1 || !postalCode || !city) return null;
  return { line1, postalCode, city, country: "PL" };
}

function isActiveStatus(status: string | null): boolean {
  const normalized = status?.trim().toUpperCase() ?? "";
  return normalized === "AKTYWNY" || normalized === "ACTIVE";
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
