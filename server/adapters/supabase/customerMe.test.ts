import { describe, expect, it, vi } from "vitest";
import {
  createSupabaseCustomerMePort as createManagedCustomerMePort,
  readLinkedCustomer,
} from "./customerMe.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ROW = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "buyer@example.com",
  first_name: "Bart",
  last_name: null,
  lifecycle_stage: "customer",
};

describe("managed customer-me adapter", () => {
  it("maps the existing profile projection through the caller principal", async () => {
    const client = clientReturning({ data: ROW, error: null });

    await expect(
      createManagedCustomerMePort(client as never).getCustomerMe(USER_ID),
    ).resolves.toEqual({
      clientId: ROW.id,
      email: ROW.email,
      firstName: ROW.first_name,
      lastName: ROW.last_name,
      lifecycleStage: ROW.lifecycle_stage,
    });
    expect(client.from).toHaveBeenCalledWith("clients");
    expect(client.select).toHaveBeenCalledWith(
      "id, email, first_name, last_name, lifecycle_stage",
    );
    expect(client.eq).toHaveBeenCalledWith("auth_user_id", USER_ID);
  });

  it("returns null for an unlinked principal and propagates upstream errors", async () => {
    await expect(
      createManagedCustomerMePort(
        clientReturning({ data: null, error: null }) as never,
      ).getCustomerMe(USER_ID),
    ).resolves.toBeNull();
    await expect(
      createManagedCustomerMePort(
        clientReturning({
          data: null,
          error: new Error("read failed"),
        }) as never,
      ).getCustomerMe(USER_ID),
    ).rejects.toThrow("read failed");
  });

  it("adds phone only for the aggregate self-service projection", async () => {
    const client = clientReturning({ data: { ...ROW, phone: "+48123456789" }, error: null });

    await expect(readLinkedCustomer(client as never, USER_ID, true))
      .resolves.toMatchObject({ id: ROW.id, phone: "+48123456789" });
    expect(client.select).toHaveBeenCalledWith(
      "id, email, first_name, last_name, phone, lifecycle_stage",
    );
  });
});

function clientReturning(result: {
  data: (typeof ROW & { phone?: string | null }) | null;
  error: Error | null;
}) {
  const maybeSingle = vi.fn(async () => result);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { eq, from, select };
}
