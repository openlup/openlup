import type { CustomerMeResponse } from "./customerContracts.js";
import type { CustomerMePort } from "./customerPorts.js";
import type { PgGatewayClient } from "../data/index.js";

type CustomerMeRow = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  lifecycle_stage: CustomerMeResponse["lifecycleStage"];
};


export function createPostgresCustomerMePort(gateway: PgGatewayClient): CustomerMePort {
  return {
    async getCustomerMe(): Promise<CustomerMeResponse | null> {
      const { data, error } = await gateway
        .from<CustomerMeRow>("clients")
        .select("id, email, first_name, last_name, lifecycle_stage")
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;

      return {
        clientId: data.id,
        email: data.email,
        firstName: data.first_name,
        lastName: data.last_name,
        lifecycleStage: data.lifecycle_stage as CustomerMeResponse["lifecycleStage"],
      };
    },
  };
}
