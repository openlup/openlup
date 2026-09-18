import {
  validateCompanyField,
  validateConsentField,
  validateEmailField,
  validateNameField,
} from "@/lib/schemas/fields";

export interface ProducerContactInput {
  name: string;
  company: string;
  email: string;
  consent: boolean;
}

export type ProducerContactValidationResult =
  | { success: true; value: { name: string; company: string; email: string } }
  | { success: false };

export function validateProducerContact(
  input: ProducerContactInput,
): ProducerContactValidationResult {
  const name = validateNameField(input.name);
  const company = validateCompanyField(input.company);
  const email = validateEmailField(input.email);
  const consent = validateConsentField(input.consent);

  if (!name.success || !company.success || !email.success || !consent.success) {
    return { success: false };
  }

  return {
    success: true,
    value: {
      name: name.value,
      company: company.value,
      email: email.value,
    },
  };
}
