import { afterEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import handler from "./invoice-data-lookup.js";
import {
  createInvoiceDataLookupPortFromEnv,
  createHiddenInvoiceDataLookupRoute,
  invoiceDataLookupEnabled,
} from "./shared.js";

describe("invoice data lookup BFF route", () => {
  afterEach(() => {
    delete process.env.COMMERCE_ACCOUNTING_INVOICE_DATA_LOOKUP_ENABLED;
    delete process.env.COMMERCE_ACCOUNTING_INVOICE_DATA_LOOKUP_MODE;
    delete process.env.GUS_CEIDG_LOOKUP_ENABLED;
    delete process.env.GUS_CEIDG_LOOKUP_BASE_URL;
    delete process.env.VERCEL_ENV;
  });

  it("fails closed before constructing a lookup port when disabled", async () => {
    const factory = vi.fn();
    const res = response();

    await createHiddenInvoiceDataLookupRoute(factory)(request("GET"), res);

    expect(factory).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body).toMatchObject({
      ok: false,
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        details: { featureFlag: "COMMERCE_ACCOUNTING_INVOICE_DATA_LOOKUP_ENABLED" },
      },
    });
  });

  it("enables on exact true or Vercel Preview, with explicit false as override", () => {
    process.env.COMMERCE_ACCOUNTING_INVOICE_DATA_LOOKUP_ENABLED = "1";
    expect(invoiceDataLookupEnabled()).toBe(false);
    process.env.COMMERCE_ACCOUNTING_INVOICE_DATA_LOOKUP_ENABLED = "true";
    expect(invoiceDataLookupEnabled()).toBe(true);
    process.env.COMMERCE_ACCOUNTING_INVOICE_DATA_LOOKUP_ENABLED = undefined;
    process.env.VERCEL_ENV = "preview";
    expect(invoiceDataLookupEnabled()).toBe(true);
    process.env.COMMERCE_ACCOUNTING_INVOICE_DATA_LOOKUP_ENABLED = "false";
    expect(invoiceDataLookupEnabled()).toBe(false);
  });

  it("returns deterministic fixture data when enabled", async () => {
    process.env.COMMERCE_ACCOUNTING_INVOICE_DATA_LOOKUP_ENABLED = "true";
    const res = response();

    await handler(request("GET", { taxId: "123-456-32-18" }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toMatchObject({
      ok: true,
      data: {
        status: "found",
        taxId: "1234563218",
        source: "static",
        legalName: "Example Commerce Sp. z o.o.",
        regon: "012345678",
        vatStatus: "active",
      },
    });
  });

  it("accepts NIP with an optional PL prefix and normalizes it before lookup", async () => {
    process.env.COMMERCE_ACCOUNTING_INVOICE_DATA_LOOKUP_ENABLED = "true";
    const res = response();

    await handler(request("POST", {}, { taxId: "PL 123-456-32-18", country: "PL" }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toMatchObject({
      ok: true,
      data: {
        status: "found",
        taxId: "1234563218",
      },
    });
  });

  it("uses an unavailable real-provider port when real lookup mode lacks credentials", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", fetchImpl);
    const port = createInvoiceDataLookupPortFromEnv({
      COMMERCE_ACCOUNTING_INVOICE_DATA_LOOKUP_MODE: "gus_ceidg",
      GUS_CEIDG_LOOKUP_ENABLED: "true",
    });

    try {
      await expect(port.lookupInvoiceData({
        taxId: "1234563218",
        country: "PL",
        providerKind: "gus_ceidg",
      })).resolves.toMatchObject({
        status: "provider_unavailable",
        providerKind: "gus_ceidg",
        taxId: "1234563218",
      });
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("uses real MF VAT lookup as the Vercel Preview default provider", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          subject: {
            name: "Example Company Sp. z o.o.",
            statusVat: "Czynny",
            workingAddress: "Example Street 11, 32-091 Example City",
          },
        },
      }),
    } as Response));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const port = createInvoiceDataLookupPortFromEnv({ VERCEL_ENV: "preview" });
      await expect(port.lookupInvoiceData({
        taxId: "1234563218",
        country: "PL",
        providerKind: "mf_vat",
      })).resolves.toMatchObject({
        status: "found",
        providerKind: "mf_vat",
        taxId: "1234563218",
        legalName: "Example Company Sp. z o.o.",
        address: {
          line1: "Example Street 11",
          postalCode: "32-091",
          city: "Example City",
        },
      });
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });
});

function request(
  method: string,
  query: Record<string, string> = {},
  body: Record<string, unknown> = {},
): VercelRequest {
  return { method, body, query, headers: {} } as unknown as VercelRequest;
}

function response(): VercelResponse & { body: unknown } {
  const res = {
    body: undefined as unknown,
    setHeader: vi.fn(),
    status: vi.fn(() => res),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
  } as unknown as VercelResponse & { body: unknown };
  return res;
}
