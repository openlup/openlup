import { z } from "zod";
z.config({ jitless: true });
export const adminUserRoleSchema = z.enum(["admin", "distributor"]);

export const adminPlatformMeRequestSchema = z.object({}).strict();

export const adminPlatformMeResponseSchema = z.object({
  isAdmin: z.boolean(),
  role: adminUserRoleSchema.nullable(),
});

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
  invitedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  code: z.enum(["INVITATION_CREATED", "ALREADY_INVITED", "INVITATION_REISSUED"]),
  message: z.string().optional(),
}), z.object({
  principalId: z.string().min(1),
  membershipState: z.literal("active"),
  role: adminUserRoleSchema,
  code: z.enum(["MEMBERSHIP_CREATED", "ALREADY_ACTIVE"]),
  message: z.string().optional(),
})]);

export const adminUserRemoveRequestSchema = z.object({
  userId: z.string().min(1),
});

export const adminUserRemoveResponseSchema = z.object({
  revoked: z.literal(true),
});

