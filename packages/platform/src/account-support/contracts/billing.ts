import type { AccountBillingProfile } from './account.js';
export interface CustomerBillingProfileInput {
 idempotencyKey: string; profileId?: string; label?: string | null; fullName: string; email: string; phone?: string | null;
 companyName?: string | null; taxId?: string | null; companyVerificationLevel?: 'registry_verified'|'provider_verified'|'manual_unverified'|'invalid'|null;
 companyIdentitySource?: string | null; companyIdentityEvidenceHash?: string | null; isDefault?: boolean;
}
export interface CustomerBillingProfileDelete { idempotencyKey: string; profileId: string }
export interface CustomerBillingProfilesResponse { contractVersion: 'customer.billing.v1'; ordererProfiles: AccountBillingProfile[] }
export interface CustomerBillingProfilePort {
 listBillingProfiles(userId: string): Promise<CustomerBillingProfilesResponse | null>;
 upsertBillingProfile(userId: string,input: CustomerBillingProfileInput): Promise<CustomerBillingProfilesResponse | null>;
 deleteBillingProfile(userId: string,input: CustomerBillingProfileDelete): Promise<CustomerBillingProfilesResponse | null>;
}
