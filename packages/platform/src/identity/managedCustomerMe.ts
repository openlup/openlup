import type { ManagedIdentityClient } from "./managedClient.js";
import type { CustomerMeResponse } from "./customerContracts.js";
import type { CustomerMePort } from "./customerPorts.js";

type ManagedCustomerClient = ManagedIdentityClient;
type LinkedCustomerRow = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  lifecycle_stage: CustomerMeResponse["lifecycleStage"];
};

export async function readLinkedCustomer(
  rawClient: unknown,
  userId: string,
  includePhone = false,
): Promise<LinkedCustomerRow | null> {
  const client = rawClient as ManagedCustomerClient;
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


export function createSupabaseCustomerMePort(
  rawClient: unknown,
): CustomerMePort {
  const client = rawClient as ManagedCustomerClient;
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
