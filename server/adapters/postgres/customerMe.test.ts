import { describe, expect, it, vi } from "vitest";
import { createPostgresCustomerMePort } from "./customerMe.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ROW = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "buyer@example.com",
  first_name: null,
  last_name: "Buyer",
  lifecycle_stage: "tester",
};

describe("Postgres customer-me adapter", () => {
  it("uses the exact profile projection and lets the actor transaction enforce principal ownership", async () => {
    const gateway = gatewayReturning({ data: ROW, error: null });

    await expect(createPostgresCustomerMePort(gateway as never).getCustomerMe(USER_ID)).resolves.toEqual({
      clientId: ROW.id,
      email: ROW.email,
      firstName: ROW.first_name,
      lastName: ROW.last_name,
      lifecycleStage: ROW.lifecycle_stage,
    });
    expect(gateway.from).toHaveBeenCalledWith("clients");
    expect(gateway.select).toHaveBeenCalledWith("id, email, first_name, last_name, lifecycle_stage");
  });

  it("returns null for no RLS-visible profile and propagates query errors", async () => {
    await expect(createPostgresCustomerMePort(gatewayReturning({ data: null, error: null }) as never).getCustomerMe(USER_ID))
      .resolves.toBeNull();
    await expect(createPostgresCustomerMePort(gatewayReturning({ data: null, error: new Error("query failed") }) as never).getCustomerMe(USER_ID))
      .rejects.toThrow("query failed");
  });
});

function gatewayReturning(result: { data: typeof ROW | null; error: Error | null }) {
  const maybeSingle = vi.fn(async () => result);
  const select = vi.fn(() => ({ maybeSingle }));
  const from = vi.fn(() => ({ select }));
  return { from, select };
}
