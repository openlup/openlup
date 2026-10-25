import { z } from "../../lib/validation/zod.js";
import { configuratorIntentSchema } from "./configuratorIntentContracts.js";
import { configuratorIntentPersistenceResponseCoreSchema } from "@openlup/platform/commerce";
export { CONFIGURATOR_INTENT_PERSISTENCE_CONTRACT_VERSION, configuratorIntentClientMatchReasonSchema } from "@openlup/platform/commerce";
export const configuratorIntentPersistenceRequestSchema = configuratorIntentSchema;
const { addressId, clientMatchReason, replayed } = configuratorIntentPersistenceResponseCoreSchema.shape;
export const configuratorIntentPersistenceResponseSchema = configuratorIntentPersistenceResponseCoreSchema
  .omit({ addressId: true, clientMatchReason: true, replayed: true })
  .extend({ petId: z.guid(), addressId, clientMatchReason, replayed });
export type ConfiguratorIntentPersistenceRequest = z.input<
  typeof configuratorIntentPersistenceRequestSchema
>;
export type ConfiguratorIntentPersistenceResponse = z.infer<
  typeof configuratorIntentPersistenceResponseSchema
>;
