import type { SupabaseClient } from "@supabase/supabase-js";
import type { OperationalEventRecorder } from "../../_lib/observability/operationalEvents.js";
import { CUSTOMER_SELF_SERVICE_CONTRACT_VERSION } from "../../../src/domains/customers/selfServiceContracts.js";
import type { CustomerAccountPort, CustomerAddressMutationPort, CustomerPetsPort, CustomerProfileMutationPort, CustomerSubscriptionActionPort } from "../../domains/customers/ports.js";
import { CustomerSelfServiceMutationConflictError } from "../../domains/customers/customerSelfServiceErrors.js";
import { readCustomerAccountV2 } from "./customerAccountV2ReadModels.js";
import { mapProfile } from "../../domains/customers/customerSelfServiceClientModels.js";
import {
  isUniqueViolation,
  mergePetMetadata,
  readCustomerAddressMutationResponse,
  readOwnedPet,
  readPetByIdempotencyKey,
  runIdempotentCustomerMutation,
} from "./customerSelfServiceIdempotency.js";
import { addressRow, addressUsedByActiveSubscription, clearDefaultAddress, findCanonicalAddressId } from "../../domains/customers/customerSelfServiceAddressModels.js";
import {
  compact,
  petHasActiveSubscription,
  petMetadata,
  petResponse,
  readPets,
  recordEvent,
} from "../../domains/customers/customerSelfServiceReadModels.js";
import { applyCustomerSubscriptionAction } from "./customerSubscriptionAction.js";
import type { SubscriptionRepricer } from "./subscriptionEditReprice.js";
import type { DeliveryAlignmentRowsReader } from "../../domains/customers/customerSubscriptionDeliveryAlignmentReadModel.js";
import { createSupabaseCustomerAccountReadStore } from "./customerAccountReadStore.js";
import { createSupabaseCustomerOrderHistoryReadStore } from "./customerOrderHistoryReadStore.js";
import { readLinkedCustomer as readLinkedClient } from "./customerMe.js";

interface SelfServiceDeps {
  customerClient: SupabaseClient;
  serviceClient: SupabaseClient;
  // Optional repricer populates RPC repricedLines; absent preserves no-repricing behavior.
  subscriptionRepricer?: SubscriptionRepricer;
  genericBundleActionsEnabled?: boolean;
  operationalEvents?: OperationalEventRecorder;
}

type SelfServicePort = CustomerAccountPort & CustomerProfileMutationPort & CustomerPetsPort & CustomerAddressMutationPort & CustomerSubscriptionActionPort;

export function createSupabaseCustomerSelfServicePort({
  customerClient,
  serviceClient,
  subscriptionRepricer,
  genericBundleActionsEnabled = false,
  operationalEvents,
}: SelfServiceDeps, readDeliveryAlignmentRows?: DeliveryAlignmentRowsReader): SelfServicePort {
  const accountStore = createSupabaseCustomerAccountReadStore(customerClient);
  const orderStore = createSupabaseCustomerOrderHistoryReadStore(customerClient, serviceClient);
  function runMutation<T>(
    clientId: string,
    eventType: string,
    idempotencyKey: string,
    readReplay: () => Promise<T | null | undefined>,
    mutate: () => Promise<T>,
  ) {
    return runIdempotentCustomerMutation({
      client: customerClient,
      clientId,
      eventType,
      idempotencyKey,
      operationalEvents,
      readReplay,
      mutate,
    });
  }

  return {
    async getAccount(userId) {
      const client = await readLinkedClient(customerClient, userId, true);
      if (!client) return null;
      return readCustomerAccountV2(
        customerClient,
        serviceClient,
        accountStore,
        orderStore,
        client,
        readDeliveryAlignmentRows,
      );
    },

    async updateProfile(userId, input) {
      const client = await readLinkedClient(customerClient, userId, true);
      if (!client) return null;
      return runMutation(
        client.id,
        "customer.profile_updated",
        input.idempotencyKey,
        async () => ({
          contractVersion: CUSTOMER_SELF_SERVICE_CONTRACT_VERSION,
          profile: mapProfile(client),
        }),
        async () => {
          const patch = compact({
            first_name: input.firstName,
            last_name: input.lastName,
            phone: input.phone,
            updated_at: new Date().toISOString(),
          });
          const { data, error } = await customerClient
            .from("clients")
            .update(patch)
            .eq("id", client.id)
            .select("id, email, first_name, last_name, phone, lifecycle_stage")
            .single();
          if (error) throw error;
          await recordEvent(accountStore, client.id, "customer.profile_updated", "client", client.id, input);
          return {
            contractVersion: CUSTOMER_SELF_SERVICE_CONTRACT_VERSION,
            profile: mapProfile(data),
          };
        },
      );
    },

    async listPets(userId) {
      const client = await readLinkedClient(customerClient, userId, true);
      if (!client) return null;
      return {
        contractVersion: CUSTOMER_SELF_SERVICE_CONTRACT_VERSION,
        pets: await readPets(accountStore, client.id),
      };
    },

    async createPet(userId, input) {
      const client = await readLinkedClient(customerClient, userId, true);
      if (!client) return null;
      const existing = await readPetByIdempotencyKey(customerClient, client.id, input.idempotencyKey);
      if (existing) return petResponse(existing);
      const now = new Date().toISOString();
      const { data, error } = await customerClient
        .from("pets")
        .insert({
          client_id: client.id,
          pet_type: input.petType,
          name: input.name,
          breed: input.breed ?? null,
          age_label: input.ageLabel ?? null,
          weight_kg: input.weightKg ?? null,
          metadata: petMetadata(input),
          updated_at: now,
        })
        .select(petSelect)
        .single();
      if (error) {
        if (isUniqueViolation(error)) {
          const replayed = await readPetByIdempotencyKey(customerClient, client.id, input.idempotencyKey);
          if (replayed) {
            operationalEvents?.({
              name: "customer_self_service_unique_violation_replay",
              domain: "customers",
              surface: "customer",
              details: { eventType: "customer.pet_created" },
            });
            return petResponse(replayed);
          }
        }
        throw error;
      }
      await recordEvent(accountStore, client.id, "customer.pet_created", "pet", data.id, input);
      return petResponse(data);
    },

    async updatePet(userId, input) {
      const client = await readLinkedClient(customerClient, userId, true);
      if (!client) return null;
      return runMutation(
        client.id,
        "customer.pet_updated",
        input.idempotencyKey,
        async () => {
          const replayed = await readOwnedPet(customerClient, client.id, input.petId);
          return replayed ? petResponse(replayed) : null;
        },
        async () => {
          const current = await readOwnedPet(customerClient, client.id, input.petId);
          const patch = compact({
            name: input.name,
            breed: input.breed,
            age_label: input.ageLabel,
            weight_kg: input.weightKg,
            metadata: mergePetMetadata(current?.metadata, petMetadata(input)),
            updated_at: new Date().toISOString(),
          });
          const { data, error } = await customerClient
            .from("pets")
            .update(patch)
            .eq("id", input.petId)
            .eq("client_id", client.id)
            .select(petSelect)
            .single();
          if (error) throw error;
          await recordEvent(accountStore, client.id, "customer.pet_updated", "pet", input.petId, input);
          return petResponse(data);
        },
      );
    },

    async removePet(userId, input) {
      const client = await readLinkedClient(customerClient, userId, true);
      if (!client) return null;
      return runMutation(
        client.id,
        "customer.pet_removed",
        input.idempotencyKey,
        async () => {
          const replayed = await readOwnedPet(customerClient, client.id, input.petId);
          return replayed ? petResponse(replayed) : null;
        },
        async () => {
          const active = await petHasActiveSubscription(accountStore, client.id, input.petId);
          if (active) throw new CustomerSelfServiceMutationConflictError("Cannot remove a pet with an active subscription");
          const removedAt = new Date().toISOString();
          const { data, error } = await customerClient
            .from("pets")
            .update({
              removed_at: removedAt,
              removed_reason: input.reason ?? null,
              updated_at: removedAt,
            })
            .eq("id", input.petId)
            .eq("client_id", client.id)
            .select(petSelect)
            .single();
          if (error) throw error;
          await recordEvent(accountStore, client.id, "customer.pet_removed", "pet", input.petId, input);
          return petResponse(data);
        },
      );
    },

    async upsertAddress(userId, input) {
      const client = await readLinkedClient(customerClient, userId, true);
      if (!client) return null;
      return runMutation(
        client.id,
        "customer.address_upserted",
        input.idempotencyKey,
        () => readCustomerAddressMutationResponse(accountStore, client.id),
        async () => {
          const row = addressRow(client.id, input);
          if (input.isDefault) await clearDefaultAddress(accountStore, client.id, input.kind);
          const addressId = input.addressId ?? (await findCanonicalAddressId(accountStore, client.id, input));
          const query = addressId
            ? customerClient.from("addresses").update(row).eq("id", addressId).eq("client_id", client.id)
            : customerClient.from("addresses").insert(row);
          const { data, error } = await query.select("id").single();
          if (error) throw error;
          const savedAddressId = (data as Record<string, unknown> | null)?.id;
          const eventEntityId = typeof savedAddressId === "string" ? savedAddressId : addressId;
          await recordEvent(accountStore, client.id, "customer.address_upserted", "address", eventEntityId, input);
          return readCustomerAddressMutationResponse(accountStore, client.id);
        },
      );
    },

    async deleteAddress(userId, input) {
      const client = await readLinkedClient(customerClient, userId, true);
      if (!client) return null;
      return runMutation(
        client.id,
        "customer.address_deleted",
        input.idempotencyKey,
        () => readCustomerAddressMutationResponse(accountStore, client.id),
        async () => {
          const active = await addressUsedByActiveSubscription(accountStore, client.id, input.addressId);
          if (active) {
            throw new CustomerSelfServiceMutationConflictError(
              "Cannot delete an address used by an active subscription",
            );
          }
          const { error } = await customerClient
            .from("addresses")
            .delete()
            .eq("id", input.addressId)
            .eq("client_id", client.id);
          if (error) throw error;
          await recordEvent(accountStore, client.id, "customer.address_deleted", "address", input.addressId, input);
          return readCustomerAddressMutationResponse(accountStore, client.id);
        },
      );
    },

    async applyAction(userId, input) {
      return applyCustomerSubscriptionAction({
        serviceClient,
        subscriptionRepricer,
        genericBundleActionsEnabled,
        userId,
        input,
      });
    },
  };
}
const petSelect =
  "id, pet_type, name, breed, age_label, weight_kg, metadata, removed_at, removed_reason, created_at, updated_at";
