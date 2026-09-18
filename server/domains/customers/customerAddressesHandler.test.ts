import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { CustomerAddressesResponse } from "../../../src/domains/customers/contracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerAddressBookPort } from "./ports.js";
import { createCustomerAddressesHandler } from "./customerAddressesHandler.js";

const ADDRESS_BOOK: CustomerAddressesResponse = {
  contractVersion: "customer.addresses.v1",
  ordererProfiles: [
    {
      profileId: "11111111-1111-4111-8111-111111111111",
      label: "Dom",
      fullName: "Jan Kowalski",
      email: "jan@example.com",
      phone: "+48500100100",
      companyName: null,
      taxId: null,
      isDefault: true,
      createdAt: "2026-06-06T12:00:00.000+02:00",
      updatedAt: "2026-06-06T12:00:00.000+02:00",
    },
  ],
  addresses: [
    {
      addressId: "22222222-2222-4222-8222-222222222222",
      kind: "shipping",
      label: "Dom",
      recipientName: "Jan Kowalski",
      contactPhone: "+48500100100",
      companyName: null,
      taxId: null,
      line1: "Testowa 12",
      line2: null,
      city: "Warszawa",
      postalCode: "00-001",
      country: "PL",
      isDefault: true,
      deliveryNotes: "Prosze zostawic przy ochronie.",
      courierInstructions: "Domofon 12.",
      lastUsedAt: null,
      createdAt: "2026-06-06T12:00:00.000+02:00",
      updatedAt: "2026-06-06T12:00:00.000+02:00",
    },
  ],
};

describe("customer addresses handler", () => {
  it("returns customer-scoped address facts", async () => {
    const port = createPort(ADDRESS_BOOK);
    const res = createResponse();

    await createHandler({ port })(request("GET"), res);

    expect(port.getAddressBook).toHaveBeenCalledWith("user-1");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: ADDRESS_BOOK,
    });
  });

  it("rejects invalid query, missing sessions, and unlinked customers", async () => {
    const invalid = createResponse();
    await createHandler({ port: createPort(ADDRESS_BOOK) })(
      request("GET", { unexpected: "x" }),
      invalid,
    );

    const unauthorized = createResponse();
    await createHandler({
      port: createPort(ADDRESS_BOOK),
      auth: { ok: false, code: "UNAUTHORIZED", message: "Customer session required" },
    })(request("GET"), unauthorized);

    const forbidden = createResponse();
    await createHandler({ port: createPort(null) })(request("GET"), forbidden);

    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    expect(forbidden.status).toHaveBeenCalledWith(403);
  });

  it("maps auth, port, method, and invalid response failures", async () => {
    const authFailed = createResponse();
    await createHandler({ port: createPort(ADDRESS_BOOK), auth: new Error("auth down") })(
      request("GET"),
      authFailed,
    );

    const failed = createResponse();
    await createHandler({ port: createPort(new Error("DB down")) })(request("GET"), failed);

    const invalidResponse = createResponse();
    const invalidAddressBook = {
      ...ADDRESS_BOOK,
      addresses: [{ ...ADDRESS_BOOK.addresses[0]!, metadata: {} }],
    } as unknown as CustomerAddressesResponse;
    await createHandler({
      port: createPort(invalidAddressBook),
    })(request("GET"), invalidResponse);

    const method = createResponse();
    await createHandler({ port: createPort(ADDRESS_BOOK) })(request("PUT"), method);

    expect(authFailed.status).toHaveBeenCalledWith(503);
    expect(failed.status).toHaveBeenCalledWith(503);
    expect(invalidResponse.status).toHaveBeenCalledWith(502);
    expect(method.setHeader).toHaveBeenCalledWith("Allow", "GET, POST, PATCH, DELETE");
    expect(method.status).toHaveBeenCalledWith(405);
  });
});

function createHandler({
  port,
  auth = { ok: true, userId: "user-1" },
}: {
  port: CustomerAddressBookPort;
  auth?: CustomerUserAuthenticationResult | Error;
}) {
  return createCustomerAddressesHandler({
    addressBookPort: port,
    authenticateUser: vi.fn().mockImplementation(async () => {
      if (auth instanceof Error) throw auth;
      return auth;
    }),
  });
}

function request(method: string, query: Record<string, unknown> = {}): VercelRequest {
  return { method, query } as unknown as VercelRequest;
}

function createPort(result: CustomerAddressesResponse | null | Error): CustomerAddressBookPort {
  return {
    getAddressBook: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;

  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
