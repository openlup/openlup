import type { DeliveryKind } from "./delivery.js";

export type CarrierRateQuoteContractVersion = "shipping.carrier_rate.v1";

export interface CarrierRateAddress {
  readonly countryCode: string;
  readonly postalCode: string;
  readonly stateOrProvince?: string;
  readonly city?: string;
  readonly residential?: boolean;
}

export interface CarrierRateParcel {
  readonly weightGrams: number;
  readonly lengthMm?: number;
  readonly widthMm?: number;
  readonly heightMm?: number;
  readonly declaredValueMinor?: number;
}

export interface CarrierRateQuoteRequest {
  readonly contractVersion: CarrierRateQuoteContractVersion;
  readonly requestKey: string;
  readonly origin: CarrierRateAddress;
  readonly destination: CarrierRateAddress;
  readonly parcels: readonly CarrierRateParcel[];
  readonly currency: string;
  readonly serviceFilter?: readonly string[];
  readonly atTime?: string;
  readonly signal?: AbortSignal;
}

export interface CarrierRateTransitEstimate {
  readonly min: number;
  readonly max: number;
}

export interface CarrierRateOption {
  readonly carrierCode: string;
  readonly serviceCode: string;
  readonly serviceName: string;
  readonly deliveryKind: DeliveryKind;
  readonly amountMinor: number;
  readonly currency: string;
  readonly estimatedTransitDays?: CarrierRateTransitEstimate | null;
  readonly deliveryDateGuaranteed?: boolean;
  readonly providerRateRef?: string;
  readonly expiresAt?: string | null;
}

export type CarrierRateRefusalReason =
  | "unsupported_country"
  | "unsupported_currency"
  | "invalid_address"
  | "invalid_parcel"
  | "multi_parcel_unsupported"
  | "service_unsupported"
  | "authentication_failed"
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "provider_error";

export type CarrierRateQuoteResult =
  | {
      readonly kind: "quoted";
      readonly providerKind: string;
      readonly currency: string;
      readonly rates: readonly CarrierRateOption[];
      readonly providerShipmentRef?: string;
    }
  | {
      readonly kind: "no_rates";
      readonly providerKind: string;
      readonly diagnosticCode: string;
    }
  | {
      readonly kind: "refused";
      readonly providerKind: string;
      readonly reason: CarrierRateRefusalReason;
      readonly retryable: boolean;
      readonly diagnosticCode: string;
      readonly retryAfterSeconds?: number;
    };

export interface CarrierRateCapabilities {
  readonly contractVersion: CarrierRateQuoteContractVersion;
  readonly providerKind: string;
  readonly multiParcel: boolean;
  readonly dimensionsRequired: boolean;
  readonly supportedOriginCountries: readonly string[] | "any";
  readonly supportedDestinationCountries: readonly string[] | "any";
  readonly supportedCurrencies: readonly string[];
  readonly deliveryKinds: readonly DeliveryKind[];
  readonly requiresCredentials: boolean;
}

export interface CarrierRateQuotePort {
  readonly capabilities: CarrierRateCapabilities;
  quoteRates(request: CarrierRateQuoteRequest): Promise<CarrierRateQuoteResult>;
}
