import { z } from "../../lib/validation/zod.js";
import { communicationPermissionStateSchema } from "./adminPermissionsContracts.js";

export const CUSTOMER_COMMUNICATION_PREFERENCES_CONTRACT_VERSION =
  "customer.communication_preferences.v1";

const dateTimeStringSchema = z.string().datetime({ offset: true });

export const customerCommunicationPreferenceSchema = z.object({
  purpose: z.literal("marketing_newsletter"),
  state: communicationPermissionStateSchema,
  granted: z.boolean(),
  source: z.string().nullable(),
  reason: z.string().nullable(),
  capturedAt: dateTimeStringSchema.nullable(),
  updatedAt: dateTimeStringSchema.nullable(),
});

export const customerCommunicationPreferencesResponseSchema = z.object({
  contractVersion: z.literal(CUSTOMER_COMMUNICATION_PREFERENCES_CONTRACT_VERSION),
  contact: z.object({
    contactId: z.string().min(1),
    email: z.string().email(),
  }).nullable(),
  marketingNewsletter: customerCommunicationPreferenceSchema,
});

export const updateCustomerCommunicationPreferencesRequestSchema = z.object({
  marketingNewsletterConsent: z.boolean(),
});

export type CustomerCommunicationPreference = z.infer<typeof customerCommunicationPreferenceSchema>;
export type CustomerCommunicationPreferencesResponse = z.infer<
  typeof customerCommunicationPreferencesResponseSchema
>;
export type UpdateCustomerCommunicationPreferencesRequest = z.infer<
  typeof updateCustomerCommunicationPreferencesRequestSchema
>;
