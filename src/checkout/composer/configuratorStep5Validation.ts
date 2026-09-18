import {
  validateConsentField,
  validateCountryField,
  validatePostalCodeField,
  isValidPolishNip,
  normalizePolishNip,
} from "@/lib/schemas/fields";

import type { ConfiguratorFormData } from "./configuratorFormStore";

export function validateStep5(
  data: ConfiguratorFormData,
  options: { deliverySelectionEnabled?: boolean; dhlOnlyDeliveryEnabled?: boolean } = {},
): Record<string, string> {
  const errors: Record<string, string> = {};
  const setIfInvalid = (
    field: string,
    result: { success: boolean },
    messageKey: string,
  ) => {
    if (!result.success) errors[field] = messageKey;
  };

  setIfInvalid("country", validateCountryField(data.country), "checkout:errors.country");
  setIfInvalid(
    "postalCode",
    validatePostalCodeField(data.postalCode, { country: data.country }),
    "checkout:errors.postalCode",
  );

  const street = data.street.trim();
  if (street.length < 3) {
    errors.street = "checkout:errors.street";
  } else if (!/\d/.test(street)) {
    errors.street = "checkout:errors.streetNumber";
  }
  if (data.city.trim().length < 2) {
    errors.city = "checkout:errors.city";
  }
  if (options.dhlOnlyDeliveryEnabled && data.deliveryMethod !== "courier") {
    errors.deliveryMethod = "checkout:errors.deliveryMethod";
  } else if (data.deliveryMethod !== "parcel-locker" && data.deliveryMethod !== "courier") {
    errors.deliveryMethod = "checkout:errors.deliveryMethod";
  }
  if (
    !options.dhlOnlyDeliveryEnabled &&
    options.deliverySelectionEnabled &&
    data.deliveryMethod === "parcel-locker" &&
    !data.selectedPickupPoint
  ) {
    errors.selectedPickupPoint = "checkout:errors.pickupPoint";
  }
  if (data.businessInvoice.requested) {
    const normalizedTaxId = normalizePolishNip(data.businessInvoice.taxIdInput);
    if (!normalizedTaxId || !isValidPolishNip(normalizedTaxId)) {
      errors.businessInvoiceTaxId = "checkout:errors.businessInvoiceTaxId";
    } else if (
      data.businessInvoice.lookupStatus !== "found" ||
      !data.businessInvoice.acceptedData ||
      data.businessInvoice.acceptedData.taxId !== normalizedTaxId ||
      !data.businessInvoice.acceptedData.companyName ||
      !data.businessInvoice.acceptedData.address.line1 ||
      !data.businessInvoice.acceptedData.address.postalCode ||
      !data.businessInvoice.acceptedData.address.city
    ) {
      errors.businessInvoiceLookup = "checkout:errors.businessInvoiceLookup";
    }
  }
  setIfInvalid("gdprConsent", validateConsentField(data.gdprConsent), "checkout:errors.gdprConsent");
  setIfInvalid("termsConsent", validateConsentField(data.termsConsent), "checkout:errors.termsConsent");

  return errors;
}
