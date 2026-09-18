import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CUSTOMER_BILLING_CONTRACT_VERSION,
  type CustomerBillingProfileDeleteRequest,
  type CustomerBillingProfilesResponse,
  type CustomerBillingProfileUpsertRequest,
} from "../../../src/domains/customers/accountV2Contracts.js";
import { compact, recordEvent } from "../../domains/customers/customerSelfServiceReadModels.js";
import { readOrdererProfiles } from "../../domains/customers/customerSelfServiceAddressModels.js";
import type { CustomerAddressReadStore } from "../../domains/customers/customerSelfServiceAddressModels.js";
import type { CustomerAccountReadStore } from "../../domains/customers/customerSelfServiceReadModels.js";

export async function listBillingProfiles(
  store: CustomerAddressReadStore,
  clientId: string,
): Promise<CustomerBillingProfilesResponse> {
  return {
    contractVersion: CUSTOMER_BILLING_CONTRACT_VERSION,
    ordererProfiles: await readOrdererProfiles(store, clientId),
  };
}

export async function upsertBillingProfile(
  customerClient: SupabaseClient,
  store: CustomerAccountReadStore & CustomerAddressReadStore,
  clientId: string,
  input: CustomerBillingProfileUpsertRequest,
): Promise<CustomerBillingProfilesResponse> {
  if (input.isDefault) await clearDefaultBillingProfile(customerClient, clientId);
  const row = billingProfileRow(clientId, input);
  const query = input.profileId
    ? customerClient
        .from("customer_orderer_profiles")
        .update(row)
        .eq("id", input.profileId)
        .eq("client_id", clientId)
    : customerClient.from("customer_orderer_profiles").insert(row);
  const { error } = await query.select("id").single();
  if (error) throw error;
  await recordEvent(
    store,
    clientId,
    "customer.billing_profile_upserted",
    "customer_orderer_profile",
    input.profileId ?? null,
    input,
  );
  return listBillingProfiles(store, clientId);
}

export async function deleteBillingProfile(
  customerClient: SupabaseClient,
  store: CustomerAccountReadStore & CustomerAddressReadStore,
  clientId: string,
  input: CustomerBillingProfileDeleteRequest,
): Promise<CustomerBillingProfilesResponse> {
  const { error } = await customerClient
    .from("customer_orderer_profiles")
    .delete()
    .eq("id", input.profileId)
    .eq("client_id", clientId);
  if (error) throw error;
  await recordEvent(
    store,
    clientId,
    "customer.billing_profile_deleted",
    "customer_orderer_profile",
    input.profileId,
    input,
  );
  return listBillingProfiles(store, clientId);
}

async function clearDefaultBillingProfile(customerClient: SupabaseClient, clientId: string) {
  const { error } = await customerClient
    .from("customer_orderer_profiles")
    .update({ is_default: false, updated_at: new Date().toISOString() })
    .eq("client_id", clientId);
  if (error) throw error;
}

export function billingProfileRow(clientId: string, input: CustomerBillingProfileUpsertRequest) {
  return compact({
    client_id: clientId,
    label: input.label ?? null,
    full_name: input.fullName,
    email: input.email,
    phone: input.phone ?? null,
    company_name: input.companyName ?? null,
    tax_id: input.taxId ?? null,
    company_verification_level: input.companyVerificationLevel ?? null,
    company_identity_source: input.companyIdentitySource ?? null,
    company_identity_evidence_hash: input.companyIdentityEvidenceHash ?? null,
    is_default: input.isDefault ?? false,
    source: "customer_account",
    updated_at: new Date().toISOString(),
  });
}
