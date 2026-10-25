import { createSupabaseConfiguratorIntentPersistencePort as createPort, type ConfiguratorIntentSupabaseClient as RpcClient, type ConfiguratorIntentPersistenceIdentity } from "@openlup/platform/commerce/server";
import { configuratorIntentPersistenceResponseSchema, type ConfiguratorIntentPersistenceRequest, type ConfiguratorIntentPersistenceResponse } from "../../../src/domains/commerce/configuratorIntentPersistenceContracts.js";
import type { CheckoutCommandV1 } from "../../../src/domains/commerce/checkoutCommandContracts.js";
import type { ConfiguratorIntentPersistencePort } from "../../../src/domains/commerce/ports.js";
import type { CheckoutCommandPersistencePort } from "../../../src/domains/commerce/runtimePorts.js";
import { z } from "../../../src/lib/validation/zod.js";
import { normalizePhoneToE164 } from "../../../src/lib/schemas/fields/phone.js";
export type { ConfiguratorIntentPersistenceIdentity } from "@openlup/platform/commerce/server";
export type ConfiguratorIntentSupabaseClient = RpcClient<ConfiguratorIntentPersistenceRequest, CheckoutCommandV1>;
const checkoutCommandRpcResponseSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  clientId: z.guid(),
  petId: z.guid().nullable(),
  addressId: z.guid(),
  replayed: z.boolean(),
}).passthrough();

export function createSupabaseConfiguratorIntentPersistencePort(
  client: ConfiguratorIntentSupabaseClient,
  identity: ConfiguratorIntentPersistenceIdentity = { authenticatedUserId: null },
): ConfiguratorIntentPersistencePort & CheckoutCommandPersistencePort {
  return createPort<ConfiguratorIntentPersistenceRequest, ConfiguratorIntentPersistenceResponse, CheckoutCommandV1, Awaited<ReturnType<CheckoutCommandPersistencePort["persistCheckoutCommand"]>>>(client, {
    responseSchema: configuratorIntentPersistenceResponseSchema, normalizePhoneToE164,
    decodeCommandResponse(data) {
      const persisted = checkoutCommandRpcResponseSchema.parse(data);
      return { idempotencyKey: persisted.idempotencyKey, clientId: persisted.clientId,
        subjectId: persisted.petId, shippingAddressId: persisted.addressId, replayed: persisted.replayed };
    },
  }, identity);
}
