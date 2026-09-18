import { z } from "../../lib/validation/zod.js";
import {
  COMMUNICATION_PERMISSION_STATES,
  COMMUNICATION_PURPOSES,
} from "./types.js";

const dateTimeStringSchema = z.string().datetime({ offset: true });
const jsonRecordSchema = z.record(z.string(), z.unknown());

export const communicationPurposeSchema = z.enum(COMMUNICATION_PURPOSES);
export const communicationPermissionStateSchema = z.enum(COMMUNICATION_PERMISSION_STATES);

export const adminCommunicationContactSchema = z.object({
  id: z.string().min(1),
  created_at: dateTimeStringSchema,
  updated_at: dateTimeStringSchema,
  normalized_email: z.string().email(),
  display_email: z.string().email(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  status: z.enum(["active", "suppressed", "invalid"]),
  metadata: jsonRecordSchema,
});

export const adminCommunicationContactLinkSchema = z.object({
  source_system: z.string().min(1),
  source_table: z.enum([
    "testers",
    "waitlist",
    "clients",
    "client_consents",
    "b2b_inquiries",
    "notification_recipients",
  ]),
  source_id: z.string().nullable().optional(),
  source_key: z.string().nullable().optional(),
  metadata: jsonRecordSchema,
  created_at: dateTimeStringSchema,
});

export const adminCommunicationPermissionSchema = z.object({
  purpose: communicationPurposeSchema,
  state: communicationPermissionStateSchema,
  source: z.string().min(1),
  source_ref: jsonRecordSchema,
  reason: z.string().nullable(),
  captured_at: dateTimeStringSchema,
  metadata: jsonRecordSchema,
  updated_at: dateTimeStringSchema,
});

export const adminCommunicationPermissionEventSchema = z.object({
  purpose: communicationPurposeSchema,
  state: communicationPermissionStateSchema,
  source: z.string().min(1),
  source_ref: jsonRecordSchema,
  reason: z.string().nullable(),
  captured_at: dateTimeStringSchema,
  metadata: jsonRecordSchema,
  created_at: dateTimeStringSchema,
});

export const adminCommunicationPermissionsReadResponseSchema = z.object({
  email: z.string().email(),
  contact: adminCommunicationContactSchema.nullable(),
  permissions: z.array(adminCommunicationPermissionSchema),
  links: z.array(adminCommunicationContactLinkSchema),
  events: z.array(adminCommunicationPermissionEventSchema),
});

export const updateAdminCommunicationPermissionRequestSchema = z.object({
  email: z.string().trim().email(),
  purpose: communicationPurposeSchema,
  state: communicationPermissionStateSchema,
  reason: z.string().trim().min(3).max(500),
  firstName: z.string().trim().min(1).max(120).optional(),
  lastName: z.string().trim().min(1).max(120).optional(),
  metadata: jsonRecordSchema.optional(),
});

export const updateAdminCommunicationPermissionResponseSchema = z.object({
  updated: z.literal(true),
  contactId: z.string().min(1),
  event: z.unknown(),
});

export type CommunicationPurpose = z.infer<typeof communicationPurposeSchema>;
export type CommunicationPermissionState = z.infer<typeof communicationPermissionStateSchema>;
export type AdminCommunicationContact = z.infer<typeof adminCommunicationContactSchema>;
export type AdminCommunicationContactLink = z.infer<typeof adminCommunicationContactLinkSchema>;
export type AdminCommunicationPermission = z.infer<typeof adminCommunicationPermissionSchema>;
export type AdminCommunicationPermissionEvent = z.infer<typeof adminCommunicationPermissionEventSchema>;
export type AdminCommunicationPermissionsReadResponse = z.infer<
  typeof adminCommunicationPermissionsReadResponseSchema
>;
export type UpdateAdminCommunicationPermissionRequest = z.infer<
  typeof updateAdminCommunicationPermissionRequestSchema
>;
export type UpdateAdminCommunicationPermissionResponse = z.infer<
  typeof updateAdminCommunicationPermissionResponseSchema
>;
