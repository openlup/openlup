import { customerCommunicationPreferencesResponseSchema } from "../../../src/domains/communications/customerPreferencesContracts.js";
import type { CustomerCommunicationPreferencesPort } from "../../domains/communications/customerCommunicationPreferencesHandler.js";


type RpcClient = {
  rpc(name: string, args?: Record<string, unknown>): Promise<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
};

export function createPostgresCustomerCommunicationPreferencesPort(
  gateway: RpcClient,
): CustomerCommunicationPreferencesPort {
  return {
    async getPreferences() {
      const { data, error } = await gateway.rpc("customer_communication_preferences_as_actor");
      if (error) throw error;
      return data === null ? null : customerCommunicationPreferencesResponseSchema.parse(data);
    },
    async updatePreferences(_principalId, input) {
      const { data, error } = await gateway.rpc(
        "customer_communication_preferences_set_as_actor",
        { p_marketing_newsletter_consent: input.marketingNewsletterConsent },
      );
      if (error) throw error;
      return data === null ? null : customerCommunicationPreferencesResponseSchema.parse(data);
    },
  };
}
