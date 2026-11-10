export type CustomerPreferenceScope = 'one_time' | 'subscription' | 'any';
export interface CustomerPaymentPreferenceInput { scope: CustomerPreferenceScope; methodKind: string }
export interface CustomerPaymentPreference extends CustomerPaymentPreferenceInput { lastSelectedAt: string }
export interface CustomerPreferencePickupPoint { id: string; name: string; address: { line1: string; postalCode: string; city: string; country: string } | null }
export interface CustomerDeliveryPreferenceInput { scope: CustomerPreferenceScope; deliveryKind: 'courier' | 'parcel-locker'; providerKind: string; carrierKind: string; carrierCode: string; serviceCode: string; pickupPoint?: CustomerPreferencePickupPoint | null }
export interface CustomerDeliveryPreference extends Omit<CustomerDeliveryPreferenceInput,'pickupPoint'> { pickupPoint: CustomerPreferencePickupPoint | null; lastSelectedAt: string }
