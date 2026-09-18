import type { createCustomerClient } from "../../_lib/customer-domain/auth.js";
import type { CustomerMeResponse } from "../../../src/domains/customers/contracts.js";
import type { CustomerMePort } from "../../domains/customers/ports.js";

type ManagedCustomerClient = ReturnType<typeof createCustomerClient>;
type LinkedCustomerRow = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  lifecycle_stage: CustomerMeResponse["lifecycleStage"];
};

export async function readLinkedCustomer(
  client: ManagedCustomerClient,
  userId: string,
  includePhone = false,
): Promise<LinkedCustomerRow | null> {
  const { data, error } = await client
    .from("clients")
    .select(includePhone
      ? "id, email, first_name, last_name, phone, lifecycle_stage"
      : "id, email, first_name, last_name, lifecycle_stage")
    .eq("auth_user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as unknown as LinkedCustomerRow | null;
}

/** Managed customer-profile read scoped by the caller's bearer-bound client. */
export function createSupabaseCustomerMePort(
  client: ManagedCustomerClient,
): CustomerMePort {
  return {
    async getCustomerMe(userId): Promise<CustomerMeResponse | null> {
      const data = await readLinkedCustomer(client, userId);
      if (!data) return null;

      return {
        clientId: data.id,
        email: data.email,
        firstName: data.first_name,
        lastName: data.last_name,
        lifecycleStage:
          data.lifecycle_stage as CustomerMeResponse["lifecycleStage"],
      };
    },
  };
}
