import { MAX_CADENCE_DAYS } from "@openlup/core/subscription";
import { ConfiguratorIntentPersistenceConflictError, createConfiguratorIntentPersistenceRpcPort as createPort, type ConfiguratorIntentRpcQueryClient as RpcClient, type ConfiguratorIntentPersistenceIdentity } from "@openlup/platform/commerce/server";
import { configuratorIntentPersistenceResponseSchema, type ConfiguratorIntentPersistenceRequest, type ConfiguratorIntentPersistenceResponse } from "../../../src/domains/commerce/configuratorIntentPersistenceContracts.js";
import type { CheckoutCommandV1 } from "../../../src/domains/commerce/checkoutCommandContracts.js";
import type { ConfiguratorIntentPersistencePort } from "../../../src/domains/commerce/ports.js";
import type { CheckoutCommandPersistencePort } from "../../../src/domains/commerce/runtimePorts.js";
import { z } from "../../../src/lib/validation/zod.js";
import { normalizePhoneToE164 } from "../../../src/lib/schemas/fields/phone.js";
export type { ConfiguratorIntentPersistenceIdentity } from "@openlup/platform/commerce/server";
export type ConfiguratorIntentSupabaseClient = RpcClient<ConfiguratorIntentPersistenceRequest, CheckoutCommandV1>;
interface CompletedIntentRpc {
  rpc(name: "commerce_configurator_read_completed_intent", args: {
    p_idempotency_key: string;
    p_auth_user_id: string | null;
  }): PromiseLike<{ data: unknown; error: unknown }>;
  rpc(name: "commerce_configurator_replay_checkout_command", args: {
    p_command: CheckoutCommandV1 & ConfiguratorIntentPersistenceIdentity;
  }): PromiseLike<{ data: unknown; error: unknown }>;
}
type CommandPersistence = Awaited<ReturnType<CheckoutCommandPersistencePort["persistCheckoutCommand"]>>;
const completedIntentRows = z.array(z.object({
  response_payload: z.unknown(),
  request_fingerprint: z.string().nullable(),
})).max(1);
const checkoutCommandRpcResponseSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  clientId: z.guid(),
  petId: z.guid().nullable(),
  addressId: z.guid(),
  replayed: z.boolean(),
}).passthrough();

function decodeCommandResponse(data: unknown): CommandPersistence {
  const persisted = checkoutCommandRpcResponseSchema.parse(data);
  return { idempotencyKey: persisted.idempotencyKey, clientId: persisted.clientId,
    subjectId: persisted.petId, shippingAddressId: persisted.addressId, replayed: persisted.replayed };
}

export function createSupabaseConfiguratorIntentPersistencePort(
  client: ConfiguratorIntentSupabaseClient,
  identity: ConfiguratorIntentPersistenceIdentity = { authenticatedUserId: null },
): ConfiguratorIntentPersistencePort & CheckoutCommandPersistencePort & {
  replayCheckoutCommand(command: CheckoutCommandV1): Promise<CommandPersistence | null>;
} {
  const completedIntentClient = client as unknown as CompletedIntentRpc;
  const port = createPort<ConfiguratorIntentPersistenceRequest, ConfiguratorIntentPersistenceResponse, CheckoutCommandV1, CommandPersistence>(client, {
    responseSchema: configuratorIntentPersistenceResponseSchema, normalizePhoneToE164,
    async readCompletedReceipt(idempotencyKey) {
      const { data, error } = await completedIntentClient.rpc("commerce_configurator_read_completed_intent", {
        p_idempotency_key: idempotencyKey,
        p_auth_user_id: identity.authenticatedUserId,
      });
      if (error) throw new Error("Configurator intent identity lookup failed");
      return completedIntentRows.parse(data)[0] ?? null;
    },
    decodeCommandResponse,
  }, identity);

  async function replayCheckoutCommand(command: CheckoutCommandV1): Promise<CommandPersistence | null> {
    // Match the managed writer's fail-open phone normalization before comparing receipts.
    const phone = normalizePhoneToE164(command.customer.phone, command.shippingAddress.country) ?? command.customer.phone;
    const { data, error } = await completedIntentClient.rpc("commerce_configurator_replay_checkout_command", {
      p_command: { ...command, customer: { ...command.customer, phone }, authenticatedUserId: identity.authenticatedUserId },
    });
    if (error) throw new Error("Checkout command receipt lookup failed");
    if (data === null) return null;
    const receipt = decodeCommandResponse(data);
    if (!receipt.replayed || receipt.idempotencyKey !== command.idempotencyKey || receipt.subjectId !== null) {
      throw new Error("Checkout command receipt is invalid");
    }
    return receipt;
  }

  return {
    ...port,
    replayCheckoutCommand,
    async persistCheckoutCommand(command) {
      const { cadenceDays } = command;
      if (cadenceDays == null || (Number.isInteger(cadenceDays) && cadenceDays >= 1 && cadenceDays <= MAX_CADENCE_DAYS)) {
        return port.persistCheckoutCommand(command);
      }

      const receipt = await replayCheckoutCommand(command);
      if (receipt) return receipt;
      throw new ConfiguratorIntentPersistenceConflictError(
        `Choose a subscription cadence from 1..${MAX_CADENCE_DAYS} days before persisting a fresh checkout identity`,
        { reason: "cadence_limit_exceeded", cadenceDays, maximumCadenceDays: MAX_CADENCE_DAYS },
      );
    },
  };
}
