import { afterEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";

const flags = vi.hoisted(() => ({
  customerAuthUiEnabled: vi.fn(() => true),
  subscriptionMutationsEnabled: vi.fn(() => true),
}));

vi.mock("../../../_lib/config/featureFlags.js", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  customerAuthUiEnabled: flags.customerAuthUiEnabled,
  subscriptionMutationsEnabled: flags.subscriptionMutationsEnabled,
}));

import handler from "./setup.js";

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

describe("customers/payment-method/setup route", () => {
  afterEach(() => {
    flags.customerAuthUiEnabled.mockReturnValue(true);
    flags.subscriptionMutationsEnabled.mockReturnValue(true);
  });

  it("fails closed (disabled) when the customer-auth UI flag is off", async () => {
    flags.customerAuthUiEnabled.mockReturnValue(false);
    const res = createResponse();
    await handler({ method: "POST", body: {}, headers: {} } as VercelRequest, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
