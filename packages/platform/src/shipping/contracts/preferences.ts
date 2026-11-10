export type CustomerPreferenceScope = 'one_time' | 'subscription' | 'any';
export interface CustomerPaymentPreferenceInput { scope: CustomerPreferenceScope; methodKind: string }
export interface CustomerPaymentPreference extends CustomerPaymentPreferenceInput { lastSelectedAt: string }
export interface CustomerPreferencePickupPoint { id: string; name: string; address: { line1: string; postalCode: string; city: string; country: string } | null }
export interface CustomerDeliveryPreferenceInput { scope: CustomerPreferenceScope; deliveryKind: 'courier' | 'parcel-locker'; providerKind: string; carrierKind: string; carrierCode: string; serviceCode: string; pickupPoint?: CustomerPreferencePickupPoint | null }
export interface CustomerDeliveryPreference extends Omit<CustomerDeliveryPreferenceInput,'pickupPoint'> { pickupPoint: CustomerPreferencePickupPoint | null; lastSelectedAt: string }
/** Redacted hints only. A missing address or profile is represented by null. */
export interface CustomerPreferenceDefaultsSnapshot {
 version: 'commerce.customer_defaults_snapshot.v1'; clientId: string;
 payment: { available: boolean; scope: CustomerPreferenceScope | null; methodKind: string | null; source: 'customer_payment_preferences'; applied: false };
 addresses: { hasDefaultShippingAddress: boolean; defaultShippingAddressId: string | null; hasDefaultBillingAddress: boolean; defaultBillingAddressId: string | null; hasDefaultOrdererProfile: boolean; defaultOrdererProfileId: string | null; hasDeliveryNotes: boolean; hasCourierInstructions: boolean; source: 'customer_address_profiles'; applied: false };
 redactedFields: ('contact'|'orderer_profile'|'shipping_address'|'billing_address'|'delivery_notes'|'courier_instructions'|'payment_provider'|'payment_secret')[];
}
