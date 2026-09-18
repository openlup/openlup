import { z } from "../../lib/validation/zod.js";
import {
  COMMUNICATION_CHANNEL,
  COMMUNICATION_PROVIDER,
  EMAIL_SEND_SKIP_REASONS,
  EMAIL_SEND_STATUSES,
} from "./types.js";

export {
  adminActiveEmailTemplateSchema,
  adminActiveEmailTemplatesResponseSchema,
  adminEmailEventSchema,
  adminEmailSendEventsRequestSchema,
  adminEmailSendEventsResponseSchema,
  adminEmailSendSchema,
  adminEmailSendsRequestSchema,
  adminEmailSendsResponseSchema,
  adminEmailSendsStatsSchema,
  adminEmailSendTesterSchema,
  adminEmailTemplateSchema,
  adminEmailTemplatesResponseSchema,
  adminTesterEmailEventSchema,
  adminTesterEmailSendSchema,
  adminTesterEmailSendsRequestSchema,
  adminTesterEmailSendsResponseSchema,
  communicationsCapturedSendResponseSchema,
  communicationsDeliveryControlMutationResponseSchema,
  communicationsDeliveryControlMutationSchema,
  communicationsDeliveryOperationEventsRequestSchema,
  communicationsDeliveryOperationEventsResponseSchema,
  communicationsDeliveryOperationSchema,
  communicationsDeliveryOperationsRequestSchema,
  communicationsDeliveryOperationsResponseSchema,
  updateAdminEmailTemplateActiveRequestSchema,
  updateAdminEmailTemplateActiveResponseSchema,
  updateAdminEmailTemplateContentRequestSchema,
  updateAdminEmailTemplateContentResponseSchema,
} from "./adminEmailConsoleContracts.js";

export {
  adminCommunicationContactLinkSchema,
  adminCommunicationContactSchema,
  adminCommunicationPermissionEventSchema,
  adminCommunicationPermissionSchema,
  adminCommunicationPermissionsReadResponseSchema,
  communicationPermissionStateSchema,
  communicationPurposeSchema,
  updateAdminCommunicationPermissionRequestSchema,
  updateAdminCommunicationPermissionResponseSchema,
} from "./adminPermissionsContracts.js";

export {
  CUSTOMER_COMMUNICATION_PREFERENCES_CONTRACT_VERSION,
  customerCommunicationPreferenceSchema,
  customerCommunicationPreferencesResponseSchema,
  updateCustomerCommunicationPreferencesRequestSchema,
} from "./customerPreferencesContracts.js";

export type {
  AdminActiveEmailTemplate,
  AdminActiveEmailTemplatesResponse,
  AdminEmailEvent,
  AdminEmailSend,
  AdminEmailSendEventsRequest,
  AdminEmailSendEventsResponse,
  AdminEmailSendsRequest,
  AdminEmailSendsResponse,
  AdminEmailSendsStats,
  AdminEmailTemplate,
  AdminEmailTemplatesResponse,
  AdminTesterEmailSend,
  AdminTesterEmailSendsRequest,
  AdminTesterEmailSendsResponse,
  CommunicationsDeliveryControlMutation,
  CommunicationsDeliveryControlMutationResponse,
  CommunicationsDeliveryOperationEventsRequest,
  CommunicationsDeliveryOperationEventsResponse,
  CommunicationsDeliveryOperationsRequest,
  CommunicationsDeliveryOperationsResponse,
  UpdateAdminEmailTemplateActiveRequest,
  UpdateAdminEmailTemplateActiveResponse,
  UpdateAdminEmailTemplateContentRequest,
  UpdateAdminEmailTemplateContentResponse,
} from "./adminEmailConsoleContracts.js";

export type {
  AdminCommunicationContact,
  AdminCommunicationContactLink,
  AdminCommunicationPermission,
  AdminCommunicationPermissionEvent,
  AdminCommunicationPermissionsReadResponse,
  CommunicationPermissionState,
  CommunicationPurpose,
  UpdateAdminCommunicationPermissionRequest,
  UpdateAdminCommunicationPermissionResponse,
} from "./adminPermissionsContracts.js";

export type {
  CustomerCommunicationPreference,
  CustomerCommunicationPreferencesResponse,
  UpdateCustomerCommunicationPreferencesRequest,
} from "./customerPreferencesContracts.js";

const dateTimeStringSchema = z.string().datetime({ offset: true });

export const emailSendStatusSchema = z.enum(EMAIL_SEND_STATUSES);
export const emailSendSkipReasonSchema = z.enum(EMAIL_SEND_SKIP_REASONS);

export const notificationRecipientTypeSchema = z.enum([
  "packaging_digest",
  "new_signup",
  "commerce_payment_critical",
]);

export const sendEmailRequestSchema = z.object({
  recipientId: z.string().trim().min(1),
  templateSlug: z.string().trim().min(1),
  source: z.string().trim().min(1).max(80).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

export const emailMessageSchema = z
  .object({
    id: z.string().min(1),
    channel: z.literal(COMMUNICATION_CHANNEL),
    recipientId: z.string().min(1),
    templateSlug: z.string().min(1),
    status: emailSendStatusSchema,
    provider: z.literal(COMMUNICATION_PROVIDER).nullable(),
    providerMessageId: z.string().min(1).nullable(),
    skippedReason: emailSendSkipReasonSchema.nullable(),
  })
  .refine(
    (message) =>
      message.status === "skipped"
        ? message.skippedReason !== null
        : message.skippedReason === null,
    {
      message: "skippedReason must be present only for skipped messages",
      path: ["skippedReason"],
    },
  )
  .refine(
    (message) =>
      message.status !== "skipped" ||
      (message.provider === null && message.providerMessageId === null),
    {
      message: "skipped messages must not include provider identifiers",
      path: ["provider"],
    },
  );

export const sendEmailResponseSchema = z.object({
  message: emailMessageSchema,
});

export const emailStatusReadRequestSchema = z
  .object({
    messageId: z.string().trim().min(1).optional(),
    providerMessageId: z.string().trim().min(1).optional(),
  })
  .refine((value) => value.messageId || value.providerMessageId, {
    message: "messageId or providerMessageId is required",
  });

export const emailStatusReadResponseSchema = z.object({
  message: emailMessageSchema,
});

export const adminNotificationRecipientsRequestSchema = z.object({
  notification_type: notificationRecipientTypeSchema,
});

export const notificationRecipientSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: z.string().nullable(),
  active: z.boolean(),
  notification_type: notificationRecipientTypeSchema,
  created_at: dateTimeStringSchema,
});

export const adminNotificationRecipientsResponseSchema = z.object({
  recipients: z.array(notificationRecipientSchema),
});

export const createNotificationRecipientRequestSchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().nullable(),
  notification_type: notificationRecipientTypeSchema,
  active: z.literal(true),
});

export const createNotificationRecipientResponseSchema = z.object({
  created: z.literal(true),
  email: z.string().email(),
  notification_type: notificationRecipientTypeSchema,
});

export const updateNotificationRecipientRequestSchema = z.object({
  recipientId: z.string().trim().min(1),
  active: z.boolean(),
});

export const updateNotificationRecipientResponseSchema = z.object({
  updated: z.literal(true),
  recipientId: z.string().min(1),
});

export const deleteNotificationRecipientRequestSchema = z.object({
  recipientId: z.string().trim().min(1),
});

export const deleteNotificationRecipientResponseSchema = z.object({
  deleted: z.literal(true),
  recipientId: z.string().min(1),
});

export type SendEmailRequest = z.infer<typeof sendEmailRequestSchema>;
export type SendEmailResponse = z.infer<typeof sendEmailResponseSchema>;
export type EmailStatusReadRequest = z.infer<typeof emailStatusReadRequestSchema>;
export type EmailStatusReadResponse = z.infer<typeof emailStatusReadResponseSchema>;
export type NotificationRecipientType = z.infer<typeof notificationRecipientTypeSchema>;
export type NotificationRecipient = z.infer<typeof notificationRecipientSchema>;
export type AdminNotificationRecipientsRequest = z.infer<typeof adminNotificationRecipientsRequestSchema>;
export type AdminNotificationRecipientsResponse = z.infer<typeof adminNotificationRecipientsResponseSchema>;
export type CreateNotificationRecipientRequest = z.infer<typeof createNotificationRecipientRequestSchema>;
export type CreateNotificationRecipientResponse = z.infer<typeof createNotificationRecipientResponseSchema>;
export type UpdateNotificationRecipientRequest = z.infer<typeof updateNotificationRecipientRequestSchema>;
export type UpdateNotificationRecipientResponse = z.infer<typeof updateNotificationRecipientResponseSchema>;
export type DeleteNotificationRecipientRequest = z.infer<typeof deleteNotificationRecipientRequestSchema>;
export type DeleteNotificationRecipientResponse = z.infer<typeof deleteNotificationRecipientResponseSchema>;
