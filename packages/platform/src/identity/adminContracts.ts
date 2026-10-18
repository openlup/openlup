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

export const adminUserInviteResponseSchema = z.object({
  message: z.string().min(1).optional(),
});

export const adminUserRemoveRequestSchema = z.object({
  userId: z.string().min(1),
});

export const adminUserRemoveResponseSchema = z.object({
  revoked: z.literal(true),
});

