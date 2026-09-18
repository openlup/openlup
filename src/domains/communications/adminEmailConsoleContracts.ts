import { z } from "../../lib/validation/zod.js";

const dateTimeStringSchema = z.string().datetime({ offset: true });
const communicationsControlKeySchema = z.string().trim().regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/,
  "Invalid communications control key",
);
const communicationsTemplateReferenceSchema = z.string().trim().regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/,
  "Invalid communications template reference",
);

export const communicationsDeliveryOperationsRequestSchema = z.object({
  page: z.coerce.number().int().min(0).default(0),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export const communicationsDeliveryOperationEventsRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(256),
});
export const communicationsDeliveryControlMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set-control"), controlKey: communicationsControlKeySchema, enabled: z.boolean() }),
  z.object({
    action: z.literal("set-template"),
    templateReference: communicationsTemplateReferenceSchema,
    controlKey: communicationsControlKeySchema,
    active: z.boolean(),
  }),
  z.object({
    action: z.literal("send"),
    recipientReference: z.string().trim().min(1).max(256),
    templateReference: communicationsTemplateReferenceSchema,
    idempotencyKey: z.string().trim().min(1).max(256),
  }),
]);
export const communicationsDeliveryControlMutationResponseSchema = z.object({
  updated: z.literal(true),
  revision: z.number().int().positive(),
});
export const communicationsCapturedSendResponseSchema = z.object({
  accepted: z.literal(true),
  deliveryReference: z.string().min(1),
});
export const communicationsDeliveryOperationSchema = z.object({
  idempotencyKey: z.string().min(1),
  templateReference: z.string().min(1),
  recipientFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["accepted", "failed"]),
  deliveryReference: z.string().min(1).nullable(),
  errorCode: z.string().min(1).nullable(),
  attemptCount: z.number().int().positive(),
  createdAt: dateTimeStringSchema,
  updatedAt: dateTimeStringSchema,
});
export const communicationsDeliveryOperationEventSchema = z.object({
  eventId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  transition: z.enum(["attempted", "accepted", "failed", "replayed"]),
  attemptCount: z.number().int().positive(),
  operatorId: z.string().uuid(),
  occurredAt: dateTimeStringSchema,
});
export const communicationsDeliveryOperationsResponseSchema = z.object({
  operations: z.array(communicationsDeliveryOperationSchema),
  totalCount: z.number().int().nonnegative(),
  controls: z.array(z.object({
    controlKey: z.string().min(1), enabled: z.boolean(),
    revision: z.number().int().positive(), updatedAt: dateTimeStringSchema,
  })),
  templates: z.array(z.object({
    templateReference: z.string().min(1), controlKey: z.string().min(1), active: z.boolean(),
    revision: z.number().int().positive(), updatedAt: dateTimeStringSchema,
  })),
  health: z.object({
    attempted: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  readiness: z.object({
    requiredControlCount: z.number().int().nonnegative(),
    disabledControlKeys: z.array(z.string()),
  }),
});
export const communicationsDeliveryOperationEventsResponseSchema = z.object({
  events: z.array(communicationsDeliveryOperationEventSchema),
});

export const adminEmailSendsRequestSchema = z.object({
  status: z.string().trim().min(1).max(80).default("all"),
  template: z.string().trim().min(1).max(160).default("all"),
  search: z.string().max(160).default(""),
  page: z.coerce.number().int().min(0),
  pageSize: z.coerce.number().int().min(1).max(100),
});

export const adminEmailSendsStatsSchema = z.object({
  totalSent: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  opened: z.number().int().nonnegative(),
  clicked: z.number().int().nonnegative(),
});

export const adminEmailSendTesterSchema = z.object({
  first_name: z.string(),
  last_name: z.string(),
  email: z.string(),
});

export const adminEmailSendSchema = z.object({
  delivery_aggregate_id: z.string().nullable().optional(),
  delivery_last_error_code: z.string().nullable().optional(),
  delivery_order_number: z.string().nullable().optional(),
  delivery_outbox_event_id: z.string().nullable().optional(),
  delivery_status: z.string().nullable().optional(),
  id: z.string().min(1),
  provider_error: z.string().nullable(),
  provider_response: z.unknown().nullable(),
  recipient_label: z.string().nullable().optional(),
  resend_id: z.string().nullable(),
  sent_at: z.string().min(1).nullable(),
  source: z.string().nullable(),
  status: z.string().nullable(),
  template_id: z.string().nullable(),
  template_slug: z.string().nullable(),
  tester_id: z.string().nullable(),
  testers: adminEmailSendTesterSchema.nullable(),
});

export const adminEmailEventSchema = z.object({
  id: z.string().min(1),
  event_type: z.string().nullable(),
  link_url: z.string().nullable(),
  metadata: z.unknown().nullable(),
  send_id: z.string().nullable(),
  timestamp: z.string().min(1).nullable(),
});

export const adminEmailSendsResponseSchema = z.object({
  stats: adminEmailSendsStatsSchema,
  templateSlugs: z.array(z.string()),
  sends: z.array(adminEmailSendSchema),
  totalCount: z.number().int().nonnegative(),
  eventsSummary: z.record(z.string(), z.array(z.string())),
});

export const adminEmailSendEventsRequestSchema = z.object({
  sendId: z.string().trim().min(1),
});

export const adminEmailSendEventsResponseSchema = z.object({
  events: z.array(adminEmailEventSchema),
});

export const adminActiveEmailTemplateSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  sequence_order: z.number().int().nullable(),
});

export const adminActiveEmailTemplatesResponseSchema = z.object({
  templates: z.array(adminActiveEmailTemplateSchema),
});

export const adminEmailTemplateSchema = z.object({
  id: z.string().min(1),
  active: z.boolean(),
  body_html: z.string(),
  body_text: z.string().nullable(),
  name: z.string().min(1),
  sequence_order: z.number().int().nullable(),
  slug: z.string().min(1),
  subject: z.string(),
  trigger_type: z.string().nullable(),
});

export const adminEmailTemplatesResponseSchema = z.object({
  templates: z.array(adminEmailTemplateSchema),
});

export const updateAdminEmailTemplateActiveRequestSchema = z.object({
  templateId: z.string().trim().min(1),
  active: z.boolean(),
});

export const updateAdminEmailTemplateActiveResponseSchema = z.object({
  updated: z.literal(true),
  templateId: z.string().min(1),
  active: z.boolean(),
});

export const updateAdminEmailTemplateContentRequestSchema = z.object({
  templateId: z.string().trim().min(1),
  name: z.string(),
  subject: z.string(),
  bodyHtml: z.string(),
  bodyText: z.string().nullable(),
});

export const updateAdminEmailTemplateContentResponseSchema = z.object({
  updated: z.literal(true),
  templateId: z.string().min(1),
});

export const adminTesterEmailSendsRequestSchema = z.object({
  testerId: z.string().trim().min(1),
});

export const adminTesterEmailEventSchema = z.object({
  send_id: z.string().nullable(),
  event_type: z.string().nullable(),
  link_url: z.string().nullable(),
  timestamp: z.string().min(1).nullable(),
});

export const adminTesterEmailSendSchema = z.object({
  id: z.string().min(1),
  template_slug: z.string().nullable(),
  status: z.string().nullable(),
  sent_at: z.string().min(1).nullable(),
  events: z.array(adminTesterEmailEventSchema).default([]),
});

export const adminTesterEmailSendsResponseSchema = z.object({
  sends: z.array(adminTesterEmailSendSchema),
});

export type AdminEmailSendsRequest = z.infer<typeof adminEmailSendsRequestSchema>;
export type AdminEmailSendsStats = z.infer<typeof adminEmailSendsStatsSchema>;
export type AdminEmailSend = z.infer<typeof adminEmailSendSchema>;
export type AdminEmailEvent = z.infer<typeof adminEmailEventSchema>;
export type AdminEmailSendsResponse = z.infer<typeof adminEmailSendsResponseSchema>;
export type AdminEmailSendEventsRequest = z.infer<typeof adminEmailSendEventsRequestSchema>;
export type AdminEmailSendEventsResponse = z.infer<typeof adminEmailSendEventsResponseSchema>;
export type AdminActiveEmailTemplate = z.infer<typeof adminActiveEmailTemplateSchema>;
export type AdminActiveEmailTemplatesResponse = z.infer<typeof adminActiveEmailTemplatesResponseSchema>;
export type AdminEmailTemplate = z.infer<typeof adminEmailTemplateSchema>;
export type AdminEmailTemplatesResponse = z.infer<typeof adminEmailTemplatesResponseSchema>;
export type UpdateAdminEmailTemplateActiveRequest = z.infer<typeof updateAdminEmailTemplateActiveRequestSchema>;
export type UpdateAdminEmailTemplateActiveResponse = z.infer<typeof updateAdminEmailTemplateActiveResponseSchema>;
export type UpdateAdminEmailTemplateContentRequest = z.infer<typeof updateAdminEmailTemplateContentRequestSchema>;
export type UpdateAdminEmailTemplateContentResponse = z.infer<typeof updateAdminEmailTemplateContentResponseSchema>;
export type AdminTesterEmailSendsRequest = z.infer<typeof adminTesterEmailSendsRequestSchema>;
export type AdminTesterEmailSend = z.infer<typeof adminTesterEmailSendSchema>;
export type AdminTesterEmailSendsResponse = z.infer<typeof adminTesterEmailSendsResponseSchema>;
export type CommunicationsDeliveryOperationsRequest = z.infer<typeof communicationsDeliveryOperationsRequestSchema>;
export type CommunicationsDeliveryOperationsResponse = z.infer<typeof communicationsDeliveryOperationsResponseSchema>;
export type CommunicationsDeliveryOperationEventsRequest = z.infer<typeof communicationsDeliveryOperationEventsRequestSchema>;
export type CommunicationsDeliveryOperationEventsResponse = z.infer<typeof communicationsDeliveryOperationEventsResponseSchema>;
export type CommunicationsDeliveryControlMutation = z.infer<typeof communicationsDeliveryControlMutationSchema>;
export type CommunicationsDeliveryControlMutationResponse = z.infer<typeof communicationsDeliveryControlMutationResponseSchema>;
