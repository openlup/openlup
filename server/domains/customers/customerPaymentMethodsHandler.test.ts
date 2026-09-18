import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { CustomerSavedPaymentMethod } from "../../../src/domains/customers/contracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import { createCustomerPaymentMethodsHandler } from "./customerPaymentMethodsHandler.js";
import type { CustomerPaymentMethodsPort } from "./ports.js";

const METHOD: CustomerSavedPaymentMethod = {
  id: "22222222-2222-4222-8222-222222222222",
  provider: "tpay" as const,
  methodKind: "blik_payid" as const,
  status: "active" as const,
  usableFor: ["one_time", "subscription"],
  label: "BLIK w aplikacji bankowej",
};

describe("customer payment methods handler", () => {
  it("returns public saved payment method summaries without raw provider refs", async () => {
    const port = createPort([METHOD]);
    const res = createResponse();

    await createHandler({ port })(request("GET"), res);

    expect(port.listPaymentMethods).toHaveBeenCalledWith("user-1");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        contractVersion: "customer.payment_methods.v1",
        paymentMethods: [METHOD],
      },
    });
    expect(JSON.stringify(vi.mocked(res.json).mock.calls)).not.toContain("payid_");
  });

  it("rejects unsupported methods, missing sessions, unlinked customers, and invalid port responses", async () => {
    const method = createResponse();
    await createHandler({ port: createPort([METHOD]) })(request("POST"), method);

    const unauthorized = createResponse();
    await createHandler({
      port: createPort([METHOD]),
      auth: { ok: false, code: "UNAUTHORIZED", message: "Customer session required" },
    })(request("GET"), unauthorized);

    const forbidden = createResponse();
    await createHandler({ port: createPort(null) })(request("GET"), forbidden);

    const invalid = createResponse();
    await createHandler({
      port: createPort([{ ...METHOD, providerMethodRef: "payid_secret" } as never]),
    })(request("GET"), invalid);

    expect(method.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(method.status).toHaveBeenCalledWith(405);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    expect(forbidden.status).toHaveBeenCalledWith(403);
    expect(invalid.status).toHaveBeenCalledWith(502);
  });
});

function createHandler({
  port,
  auth = { ok: true, userId: "user-1" },
}: {
  port: CustomerPaymentMethodsPort;
  auth?: CustomerUserAuthenticationResult;
}) {
  return createCustomerPaymentMethodsHandler({
    paymentMethodsPort: port,
    authenticateUser: vi.fn(async () => auth),
  });
}

function createPort(result: Awaited<ReturnType<CustomerPaymentMethodsPort["listPaymentMethods"]>>): CustomerPaymentMethodsPort {
  return {
    listPaymentMethods: vi.fn(async () => result),
  };
}

function request(method: string): VercelRequest {
  return { method, query: {} } as unknown as VercelRequest;
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
