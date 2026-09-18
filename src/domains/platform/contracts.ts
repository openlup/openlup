import { z } from "../../lib/validation/zod.js";
import { emailFieldSchema } from "../../lib/schemas/fields/identity.js";

export const adminPipelineTesterSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  email_sequence_step: z.number().int().min(0).nullable(),
  email_sequence_paused: z.boolean().nullable(),
});

export const adminPipelineEmailTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sequence_order: z.number().int().min(0).nullable(),
});

export const adminPipelineEmailEventSchema = z.object({
  event_type: z.string().min(1),
});

export const adminPipelineReadRequestSchema = z.object({}).strict();

export const adminPipelineReadResponseSchema = z.object({
  testers: z.array(adminPipelineTesterSchema),
  templates: z.array(adminPipelineEmailTemplateSchema),
  emailSendCount: z.number().int().min(0),
  emailEvents: z.array(adminPipelineEmailEventSchema),
});

export const adminPipelineDhlTrackingRefreshRequestSchema = z.object({}).strict();

export const adminPipelineDhlTrackingRefreshResponseSchema = z.object({
  checked: z.number().int().min(0),
  updated: z.number().int().min(0),
});

export const adminSettingsReadRequestSchema = z.object({}).strict();

export const adminSettingsAdminUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().nullable(),
  role: z.string().nullable(),
});

export const adminSettingsReadResponseSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
  adminUsers: z.array(adminSettingsAdminUserSchema),
});

export const adminSettingWriteValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const adminSettingsUpdateRequestSchema = z.object({
  key: z.string().trim().min(1),
  value: adminSettingWriteValueSchema,
});

export const adminSettingsUpdateResponseSchema = z.object({
  key: z.string().min(1),
  saved: z.literal(true),
});

export const adminUserRoleSchema = z.enum(["admin", "distributor"]);

export const adminPlatformMeRequestSchema = z.object({}).strict();

export const adminPlatformMeResponseSchema = z.object({
  isAdmin: z.boolean(),
  role: adminUserRoleSchema.nullable(),
});

export const adminMagicLinkRequestSchema = z
  .object({
    email: emailFieldSchema({ required: true }).refine((email: string) => email.length <= 160, {
      message: "forms:fields.email.tooLong",
    }),
  })
  .strict();

export const adminMagicLinkResponseSchema = z
  .object({
    accepted: z.literal(true),
  })
  .strict();

export const adminUserRoleUpdateRequestSchema = z.object({
  userId: z.string().min(1),
  role: adminUserRoleSchema,
});

export const adminUserRoleUpdateResponseSchema = z.object({
  userId: z.string().min(1),
  role: adminUserRoleSchema,
  saved: z.literal(true),
});

export const adminUserInviteRequestSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
  role: adminUserRoleSchema,
});

export const adminUserInviteResponseSchema = z.object({
  message: z.string().min(1).optional(),
});

export const adminUserRemoveRequestSchema = z.object({
  userId: z.string().min(1),
});

export const adminUserRemoveResponseSchema = z.object({
  revoked: z.literal(true),
});

const platformControlKeySchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/);
const platformOperationKeySchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const platformTimestampSchema = z.string().datetime({ offset: true });

export const platformControlPlaneReadRequestSchema = z.object({}).strict();

export const platformControlPlaneReadResponseSchema = z.object({
  controls: z.array(z.object({
    controlKey: platformControlKeySchema,
    enabled: z.boolean(),
    revision: z.number().int().min(1),
    updatedAt: platformTimestampSchema,
  })),
  jobs: z.array(z.object({
    jobName: z.string().min(1),
    enabled: z.boolean(),
    activeDriver: z.enum(["worker", "scheduler", "operator"]),
    lastStatus: z.enum(["running", "success", "failed", "skipped"]).nullable(),
    lastStartedAt: platformTimestampSchema.nullable(),
    lastFinishedAt: platformTimestampSchema.nullable(),
    lastSuccessAt: platformTimestampSchema.nullable(),
  })),
  alerts: z.array(z.object({
    dedupeKey: z.string().min(1),
    severity: z.enum(["p0", "p1", "p2", "p3"]),
    status: z.enum(["open", "acknowledged", "resolved"]),
    owner: z.string().min(1),
    title: z.string().min(1),
    firstSeenAt: platformTimestampSchema,
    lastSeenAt: platformTimestampSchema,
    resolvedAt: platformTimestampSchema.nullable(),
  })),
});

export const platformControlPlaneMutationSchema = z.union([
  z.object({
    action: z.literal("set-control"),
    idempotencyKey: platformOperationKeySchema,
    controlKey: platformControlKeySchema,
    enabled: z.boolean(),
  }).strict(),
  z.object({
    action: z.literal("record-heartbeat"),
    idempotencyKey: platformOperationKeySchema,
    health: z.enum(["healthy", "degraded", "failed"]),
    firingCount: z.number().int().min(0),
    maxSeverity: z.enum(["p0", "p1", "p2", "p3"]).nullable(),
    promotionReady: z.boolean(),
  }).strict(),
]);

export const platformControlPlaneMutationResponseSchema = z.object({
  action: z.enum(["set-control", "record-heartbeat"]),
  replayed: z.boolean(),
  revision: z.number().int().min(1).nullable(),
  recordedAt: platformTimestampSchema,
});

export type AdminPipelineTester = z.infer<typeof adminPipelineTesterSchema>;
export type AdminPipelineEmailTemplate = z.infer<typeof adminPipelineEmailTemplateSchema>;
export type AdminPipelineEmailEvent = z.infer<typeof adminPipelineEmailEventSchema>;
export type AdminPipelineReadRequest = z.infer<typeof adminPipelineReadRequestSchema>;
export type AdminPipelineReadResponse = z.infer<typeof adminPipelineReadResponseSchema>;
export type AdminPipelineDhlTrackingRefreshRequest = z.infer<
  typeof adminPipelineDhlTrackingRefreshRequestSchema
>;
export type AdminPipelineDhlTrackingRefreshResponse = z.infer<
  typeof adminPipelineDhlTrackingRefreshResponseSchema
>;
export type AdminSettingsAdminUser = z.infer<typeof adminSettingsAdminUserSchema>;
export type AdminSettingsReadRequest = z.infer<typeof adminSettingsReadRequestSchema>;
export type AdminSettingsReadResponse = z.infer<typeof adminSettingsReadResponseSchema>;
export type AdminSettingWriteValue = z.infer<typeof adminSettingWriteValueSchema>;
export type AdminSettingsUpdateRequest = z.infer<typeof adminSettingsUpdateRequestSchema>;
export type AdminSettingsUpdateResponse = z.infer<typeof adminSettingsUpdateResponseSchema>;
export type AdminUserRole = z.infer<typeof adminUserRoleSchema>;
export type AdminPlatformMeRequest = z.infer<typeof adminPlatformMeRequestSchema>;
export type AdminPlatformMeResponse = z.infer<typeof adminPlatformMeResponseSchema>;
export type AdminMagicLinkRequest = z.infer<typeof adminMagicLinkRequestSchema>;
export type AdminMagicLinkResponse = z.infer<typeof adminMagicLinkResponseSchema>;
export type AdminUserRoleUpdateRequest = z.infer<
  typeof adminUserRoleUpdateRequestSchema
>;
export type AdminUserRoleUpdateResponse = z.infer<
  typeof adminUserRoleUpdateResponseSchema
>;
export type AdminUserInviteRequest = z.infer<typeof adminUserInviteRequestSchema>;
export type AdminUserInviteResponse = z.infer<typeof adminUserInviteResponseSchema>;
export type AdminUserRemoveRequest = z.infer<typeof adminUserRemoveRequestSchema>;
export type AdminUserRemoveResponse = z.infer<typeof adminUserRemoveResponseSchema>;
export type PlatformControlPlaneReadRequest = z.infer<typeof platformControlPlaneReadRequestSchema>;
export type PlatformControlPlaneReadResponse = z.infer<typeof platformControlPlaneReadResponseSchema>;
export type PlatformControlPlaneMutation = z.infer<typeof platformControlPlaneMutationSchema>;
export type PlatformControlPlaneMutationResponse = z.infer<typeof platformControlPlaneMutationResponseSchema>;
