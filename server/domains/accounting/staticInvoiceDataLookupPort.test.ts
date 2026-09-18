import { describe, expect, it } from "vitest";
import { createStaticInvoiceDataLookupPort } from "./staticInvoiceDataLookupPort.js";

describe("createStaticInvoiceDataLookupPort", () => {
  it("returns neutral deterministic fixture data for the known local tax id", async () => {
    const port = createStaticInvoiceDataLookupPort();

    await expect(
      port.lookupInvoiceData({ providerKind: "gus_ceidg", taxId: "1234563218", country: "PL" }),
    ).resolves.toMatchObject({
      status: "found",
      providerKind: "gus_ceidg",
      taxId: "1234563218",
      source: "local_test_fixture",
      legalName: "Example Commerce Sp. z o.o.",
      vatStatus: "active",
    });
  });

  it("returns deterministic not_found data for unknown tax ids", async () => {
    const port = createStaticInvoiceDataLookupPort();

    await expect(
      port.lookupInvoiceData({ providerKind: "gus_ceidg", taxId: "1111111111", country: "PL" }),
    ).resolves.toMatchObject({
      status: "not_found",
      providerKind: "gus_ceidg",
      taxId: "1111111111",
      legalName: null,
      vatStatus: "unknown",
    });
  });
});
