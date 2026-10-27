import { z } from "../../lib/validation/zod.js";
import { emailFieldSchema } from "../../lib/schemas/fields/identity.js";

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

export const adminUserInviteResponseSchema = z.discriminatedUnion("membershipState", [z.object({
  principalId: z.string().min(1),
  invitationId: z.string().min(1),
  membershipState: z.literal("invited"),
  role: adminUserRoleSchema,
  invitedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  code: z.enum(["INVITATION_CREATED", "ALREADY_INVITED", "INVITATION_REISSUED"]),
  message: z.string().min(1).optional(),
}), z.object({
  principalId: z.string().min(1),
  membershipState: z.literal("active"),
  role: adminUserRoleSchema,
  code: z.enum(["MEMBERSHIP_CREATED", "ALREADY_ACTIVE"]),
  message: z.string().min(1).optional(),
})]);

export const adminUserRemoveRequestSchema = z.object({
  userId: z.string().min(1),
});

export const adminUserRemoveResponseSchema = z.object({
  revoked: z.literal(true),
});

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
export {
  adminPipelineTesterSchema, adminPipelineEmailTemplateSchema, adminPipelineEmailEventSchema,
  adminPipelineReadRequestSchema, adminPipelineReadResponseSchema,
  adminPipelineDhlTrackingRefreshRequestSchema, adminPipelineDhlTrackingRefreshResponseSchema,
  adminSettingsReadRequestSchema, adminSettingsReadResponseSchema, adminSettingsAdminUserSchema,
  adminSettingWriteValueSchema, adminSettingsUpdateRequestSchema, adminSettingsUpdateResponseSchema,
  platformControlPlaneReadRequestSchema, platformControlPlaneReadResponseSchema,
  platformControlPlaneMutationSchema, platformControlPlaneMutationResponseSchema,
} from "@openlup/platform/operations";
export type {
  AdminPipelineTester, AdminPipelineEmailTemplate, AdminPipelineEmailEvent,
  AdminPipelineReadRequest, AdminPipelineReadResponse,
  AdminPipelineDhlTrackingRefreshRequest, AdminPipelineDhlTrackingRefreshResponse,
  AdminSettingsReadRequest, AdminSettingsReadResponse, AdminSettingsAdminUser,
  AdminSettingWriteValue, AdminSettingsUpdateRequest, AdminSettingsUpdateResponse,
  PlatformControlPlaneReadRequest, PlatformControlPlaneReadResponse,
  PlatformControlPlaneMutation, PlatformControlPlaneMutationResponse,
} from "@openlup/platform/operations/contracts";
