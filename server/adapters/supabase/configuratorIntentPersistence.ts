import { createConfiguratorIntentPersistenceRpcPort as createPort, type ConfiguratorIntentRpcQueryClient as RpcClient, type ConfiguratorIntentPersistenceIdentity } from "@openlup/platform/commerce/server";
import { configuratorIntentPersistenceResponseSchema, type ConfiguratorIntentPersistenceRequest, type ConfiguratorIntentPersistenceResponse } from "../../../src/domains/commerce/configuratorIntentPersistenceContracts.js";
import type { CheckoutCommandV1 } from "../../../src/domains/commerce/checkoutCommandContracts.js";
import type { ConfiguratorIntentPersistencePort } from "../../../src/domains/commerce/ports.js";
import type { CheckoutCommandPersistencePort } from "../../../src/domains/commerce/runtimePorts.js";
import { z } from "../../../src/lib/validation/zod.js";
import { createQuoteResponseSchema, commerceQuoteSchema, quoteContextSchema, type CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
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
const storedCommandQuoteSchema = createQuoteResponseSchema.extend({ quote: commerceQuoteSchema.safeExtend({
  context: quoteContextSchema.extend({ cadenceDays: z.number().int().positive().max(2_147_483_647).nullable().optional() }).optional(),
}) });

export function createSupabaseConfiguratorIntentPersistencePort(
  client: ConfiguratorIntentSupabaseClient,
  identity: ConfiguratorIntentPersistenceIdentity = { authenticatedUserId: null },
): ConfiguratorIntentPersistencePort & CheckoutCommandPersistencePort {
  return createPort<ConfiguratorIntentPersistenceRequest, ConfiguratorIntentPersistenceResponse, CheckoutCommandV1, Awaited<ReturnType<CheckoutCommandPersistencePort["persistCheckoutCommand"]>>, CreateQuoteResponse>(client, {
    responseSchema: configuratorIntentPersistenceResponseSchema, normalizePhoneToE164,
    decodeCommandQuote: (data) => storedCommandQuoteSchema.parse(data),
    decodeCommandResponse(data) {
      const persisted = checkoutCommandRpcResponseSchema.parse(data);
      return { idempotencyKey: persisted.idempotencyKey, clientId: persisted.clientId,
        subjectId: persisted.petId, shippingAddressId: persisted.addressId, replayed: persisted.replayed };
    },
  }, identity);
}
