import type {
  AdminEmailSendEventsRequest,
  AdminEmailSendEventsResponse,
  AdminEmailSendsRequest,
  AdminEmailSendsResponse,
  AdminEmailTemplatesResponse,
  AdminActiveEmailTemplatesResponse,
  AdminNotificationRecipientsRequest,
  AdminNotificationRecipientsResponse,
  AdminTesterEmailSendsRequest,
  AdminTesterEmailSendsResponse,
  CreateNotificationRecipientRequest,
  CreateNotificationRecipientResponse,
  DeleteNotificationRecipientRequest,
  DeleteNotificationRecipientResponse,
  EmailStatusReadRequest,
  EmailStatusReadResponse,
  SendEmailRequest,
  SendEmailResponse,
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
  UpdateNotificationRecipientRequest,
  UpdateNotificationRecipientResponse,
} from "./contracts.js";
import type { EmailRenderer, RenderEmailInput, RenderedEmail } from "./email/render.js";
import type {
  NewsletterSyncEvent,
} from "./newsletterIntegrationContracts.js";

export interface CommunicationSendPort {
  sendEmail(request: SendEmailRequest): Promise<SendEmailResponse>;
}

/** Provider-neutral operator surface for captured delivery control and evidence. */
export interface CommunicationControlPlanePort extends CommunicationSendPort {
  getDeliveryOperations(
    request: CommunicationsDeliveryOperationsRequest,
  ): Promise<CommunicationsDeliveryOperationsResponse>;
  getDeliveryOperationEvents(
    request: CommunicationsDeliveryOperationEventsRequest,
  ): Promise<CommunicationsDeliveryOperationEventsResponse>;
  mutateDeliveryControl(
    request: Exclude<CommunicationsDeliveryControlMutation, { action: "send" }>,
  ): Promise<CommunicationsDeliveryControlMutationResponse>;
}

// Branded email rendering surface. The default implementation is the pure
// `renderEmail` in ./email/render.ts; this port lets a fork (Apache-2.0) swap in its
// own renderer without touching content modules or send adapters.
export type { EmailRenderer, RenderEmailInput, RenderedEmail };

export interface EmailRenderPort {
  render: EmailRenderer;
}

export interface CommunicationReadPort {
  getEmailStatus(
    request: EmailStatusReadRequest,
  ): Promise<EmailStatusReadResponse>;
}

export interface CommunicationNotificationRecipientsPort {
  listNotificationRecipients(
    request: AdminNotificationRecipientsRequest,
  ): Promise<AdminNotificationRecipientsResponse>;
  createNotificationRecipient(
    request: CreateNotificationRecipientRequest,
  ): Promise<CreateNotificationRecipientResponse>;
  updateNotificationRecipient(
    request: UpdateNotificationRecipientRequest,
  ): Promise<UpdateNotificationRecipientResponse>;
  deleteNotificationRecipient(
    request: DeleteNotificationRecipientRequest,
  ): Promise<DeleteNotificationRecipientResponse>;
}

export interface CommunicationAdminEmailSendsReadPort {
  getAdminEmailSends(
    request: AdminEmailSendsRequest,
  ): Promise<AdminEmailSendsResponse>;
  getAdminEmailSendEvents(
    request: AdminEmailSendEventsRequest,
  ): Promise<AdminEmailSendEventsResponse>;
}

export interface CommunicationAdminTesterDetailReadPort {
  getActiveEmailTemplates(): Promise<AdminActiveEmailTemplatesResponse>;
  getTesterEmailSends(
    request: AdminTesterEmailSendsRequest,
  ): Promise<AdminTesterEmailSendsResponse>;
}

export interface CommunicationAdminTemplatesReadPort {
  getAdminEmailTemplates(): Promise<AdminEmailTemplatesResponse>;
}

export interface CommunicationAdminTemplateActiveWritePort {
  updateAdminEmailTemplateActive(
    request: UpdateAdminEmailTemplateActiveRequest,
  ): Promise<UpdateAdminEmailTemplateActiveResponse>;
}

export interface CommunicationAdminTemplateContentWritePort {
  updateAdminEmailTemplateContent(
    request: UpdateAdminEmailTemplateContentRequest,
  ): Promise<UpdateAdminEmailTemplateContentResponse>;
}

export type { NewsletterSyncEvent } from "./newsletterIntegrationContracts.js";

export type { NewsletterSyncOutcome, NewsletterSyncProviderPort, NewsletterSyncReconcileOutcome } from "@openlup/platform/communications/contracts";
export { CommunicationRecipientNotFoundError, CommunicationTemplateNotFoundError, CommunicationConflictError, CommunicationValidationError, CommunicationUnavailableError } from "@openlup/platform/communications";
